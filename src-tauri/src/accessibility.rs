//! macOS Accessibility (AX) primitives.
//!
//! Meeting applications publish no participant roster to other processes. Zoom's
//! SDK needs to be a credentialed participant; Meet is a web page; Teams and Slack
//! are Electron. The ONE surface all of them expose to a third-party process is the
//! accessibility tree — it exists so screen readers work — and for Chromium-based
//! apps it mirrors the DOM, including the CSS class list.
//!
//! That is the entire basis for learning a speaker's name. Everything in
//! `speaker_ax.rs` is built on the thin wrappers here.
//!
//! Memory: the `AXUIElementCopy*` calls follow Core Foundation's **create rule**
//! (they return +1 references), so every value obtained from them is released
//! exactly once — `AxElement` owns its ref and releases on drop.

#![cfg(target_os = "macos")]

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef};
use std::os::raw::c_void;

pub type AXUIElementRef = *const c_void;
type AXError = i32;
const AX_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// Does this process already hold Accessibility permission?
///
/// Accessibility is gated purely by the TCC database and takes no usage-string in
/// Info.plist, so there is nothing to declare — it is granted or it is not.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Ask for Accessibility permission, showing the system prompt.
///
/// macOS only shows this dialog ONCE per app; if the user has already declined,
/// this returns false silently and the caller should deep-link to System Settings
/// instead of calling again and appearing to do nothing.
pub fn request_trust() -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let opts = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        AXIsProcessTrustedWithOptions(opts.as_CFTypeRef())
    }
}

/// An owned reference to an element in some application's accessibility tree.
pub struct AxElement(AXUIElementRef);

// The AX API is thread-confined in principle, but reads from a single dedicated
// polling thread are the documented-safe usage and are what we do.
unsafe impl Send for AxElement {}

impl Drop for AxElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

impl AxElement {
    /// The root element for a running application.
    pub fn for_pid(pid: i32) -> Option<Self> {
        let el = unsafe { AXUIElementCreateApplication(pid) };
        if el.is_null() { None } else { Some(AxElement(el)) }
    }

    fn copy_attr(&self, name: &str) -> Option<CFType> {
        let attr = CFString::new(name);
        let mut out: CFTypeRef = std::ptr::null();
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.0, attr.as_concrete_TypeRef(), &mut out)
        };
        if err != AX_SUCCESS || out.is_null() {
            return None;
        }
        // Copy rule → we own this reference; wrap_under_create_rule releases it.
        Some(unsafe { CFType::wrap_under_create_rule(out) })
    }

    /// Read a string attribute (`AXTitle`, `AXValue`, `AXRole`, …).
    pub fn string(&self, name: &str) -> Option<String> {
        let v = self.copy_attr(name)?;
        v.downcast::<CFString>().map(|s| s.to_string())
    }

    /// Read an array-of-strings attribute. `AXDOMClassList` is the important one:
    /// it is Chromium's private attribute exposing an element's CSS classes, which
    /// is how an active-speaker highlight is recognised in Meet, Teams and Slack.
    pub fn string_array(&self, name: &str) -> Vec<String> {
        self.raw_array(name)
            .into_iter()
            .filter_map(|raw| unsafe {
                if CFGetTypeID(raw) != CFString::type_id() {
                    return None;
                }
                Some(CFString::wrap_under_get_rule(raw as _).to_string())
            })
            .collect()
    }

    /// Items of an array-valued attribute, as borrowed (+0) refs.
    fn raw_array(&self, name: &str) -> Vec<CFTypeRef> {
        let Some(v) = self.copy_attr(name) else { return Vec::new() };
        let raw = v.as_CFTypeRef();
        unsafe {
            if CFGetTypeID(raw) != core_foundation_sys::array::CFArrayGetTypeID() {
                return Vec::new();
            }
            let arr = raw as CFArrayRef;
            let n = CFArrayGetCount(arr);
            (0..n).map(|i| CFArrayGetValueAtIndex(arr, i) as CFTypeRef).collect()
        }
    }

    /// Read a child-element array (`AXChildren`, `AXWindows`).
    pub fn elements(&self, name: &str) -> Vec<AxElement> {
        self.raw_array(name)
            .into_iter()
            .filter(|r| !r.is_null())
            .map(|raw| {
                // The array holds these at +0; AxElement releases on drop, so retain.
                unsafe { CFRetain(raw) };
                AxElement(raw as AXUIElementRef)
            })
            .collect()
    }

    /// Turn on Chromium's lazy accessibility tree for this application.
    ///
    /// Chromium and Electron build their AX tree only once something asks for it.
    /// An app no screen reader has ever queried exposes almost nothing, so WITHOUT
    /// this Google Meet, Slack and Teams are all effectively invisible. This is
    /// Chromium's documented private opt-in for exactly that case.
    pub fn enable_chromium_accessibility(&self) -> bool {
        let attr = CFString::new("AXManualAccessibility");
        let val = CFBoolean::true_value();
        let err = unsafe {
            AXUIElementSetAttributeValue(self.0, attr.as_concrete_TypeRef(), val.as_CFTypeRef())
        };
        err == AX_SUCCESS
    }
}

/// Resolve a bundle identifier to the process id of its running instance.
///
/// The accessibility tree is addressed by pid, but meeting detection works from
/// bundle ids (the microphone-holder query). Returns None when the app is not
/// running — which is the normal case for every app except the one in a meeting.
pub fn pid_for_bundle_id(bundle_id: &str) -> Option<i32> {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    unsafe {
        let ns_id = NSString::from_str(bundle_id);
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_id);
        // Several instances can share a bundle id (helper processes); the first
        // running match is the one holding the window.
        apps.iter().next().map(|app| app.processIdentifier())
    }
}

/// Every running application, as `(bundle_id, pid)`.
///
/// Platform detection walks this rather than relying on which app happens to hold
/// the microphone: a user can start recording by hand, or long after the meeting
/// began, and the mic-holder signal is about prompting, not about which window has
/// the participant grid.
pub fn running_apps() -> Vec<(String, i32)> {
    use objc2_app_kit::NSWorkspace;
    let mut out = Vec::new();
    unsafe {
        let ws = NSWorkspace::sharedWorkspace();
        for app in ws.runningApplications().iter() {
            let Some(bid) = app.bundleIdentifier() else { continue };
            out.push((bid.to_string(), app.processIdentifier()));
        }
    }
    out
}

impl AxElement {
    /// Titles of this application's windows.
    ///
    /// Window titles are how an app that is merely OPEN is told apart from one
    /// that is in a call — Teams, Zoom and Slack all run all day, so a bundle id
    /// on its own proves nothing.
    pub fn window_titles(&self) -> Vec<String> {
        self.elements("AXWindows")
            .iter()
            .filter_map(|w| w.string("AXTitle"))
            .collect()
    }
}
