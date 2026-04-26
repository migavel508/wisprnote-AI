/// Audio Device Monitor for macOS
/// Listens for CoreAudio property changes to detect when default input/output
/// devices change (Bluetooth connect/disconnect, headphone plug/unplug, etc.)
/// Inspired by the char application's device-monitor crate.

#[cfg(target_os = "macos")]
pub mod macos {
    use cidre::core_audio as ca;
    use cidre::{ns, os};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[derive(Debug, Clone)]
    pub enum DeviceChange {
        DefaultInputChanged,
        DefaultOutputChanged,
        DeviceListChanged,
    }

    pub struct DeviceMonitorHandle {
        stop_tx: Option<mpsc::Sender<()>>,
        thread_handle: Option<std::thread::JoinHandle<()>>,
    }

    impl DeviceMonitorHandle {
        pub fn stop(mut self) {
            if let Some(tx) = self.stop_tx.take() {
                let _ = tx.send(());
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for DeviceMonitorHandle {
        fn drop(&mut self) {
            if let Some(tx) = self.stop_tx.take() {
                let _ = tx.send(());
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    const DEBOUNCE_DELAY: Duration = Duration::from_millis(2000);

    const SELECTORS: [ca::PropSelector; 3] = [
        ca::PropSelector::HW_DEFAULT_INPUT_DEVICE,
        ca::PropSelector::HW_DEFAULT_OUTPUT_DEVICE,
        ca::PropSelector::HW_DEVICES,
    ];

    struct MonitorCtx {
        raw_tx: mpsc::Sender<DeviceChange>,
    }

    extern "C-unwind" fn system_listener(
        _obj_id: ca::Obj,
        number_addresses: u32,
        addresses: *const ca::PropAddr,
        client_data: *mut (),
    ) -> os::Status {
        let ctx = unsafe { &*(client_data as *const MonitorCtx) };
        let addresses =
            unsafe { std::slice::from_raw_parts(addresses, number_addresses as usize) };

        for addr in addresses {
            match addr.selector {
                ca::PropSelector::HW_DEFAULT_INPUT_DEVICE => {
                    let _ = ctx.raw_tx.send(DeviceChange::DefaultInputChanged);
                }
                ca::PropSelector::HW_DEFAULT_OUTPUT_DEVICE => {
                    let _ = ctx.raw_tx.send(DeviceChange::DefaultOutputChanged);
                }
                ca::PropSelector::HW_DEVICES => {
                    let _ = ctx.raw_tx.send(DeviceChange::DeviceListChanged);
                }
                _ => {}
            }
        }
        os::Status::NO_ERR
    }

    /// Spawn a device monitor that listens for CoreAudio device changes.
    /// Events are debounced (1s) and sent to the provided channel.
    pub fn spawn_monitor(event_tx: mpsc::Sender<DeviceChange>) -> DeviceMonitorHandle {
        let (stop_tx, stop_rx) = mpsc::channel();

        let thread_handle = std::thread::spawn(move || {
            // Raw events go through debouncing before being forwarded
            let (raw_tx, raw_rx) = mpsc::channel();

            let debounced_tx = event_tx;
            let debounce_thread = std::thread::spawn(move || {
                debounce_loop(raw_rx, debounced_tx);
            });

            let ctx = MonitorCtx { raw_tx };
            let ctx_ptr = &ctx as *const MonitorCtx as *mut ();

            // Register CoreAudio property listeners
            for selector in SELECTORS {
                if let Err(e) = ca::System::OBJ.add_prop_listener(
                    &selector.global_addr(),
                    system_listener,
                    ctx_ptr,
                ) {
                    eprintln!("device_monitor: failed to add listener {:?}", e);
                    return;
                }
            }

            eprintln!("device_monitor: started");

            // Run event loop — process events until stop signal
            let run_loop = ns::RunLoop::current();
            loop {
                run_loop.run_until_date(&ns::Date::distant_future());
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            // Cleanup listeners
            for selector in SELECTORS {
                let _ = ca::System::OBJ.remove_prop_listener(
                    &selector.global_addr(),
                    system_listener,
                    ctx_ptr,
                );
            }

            drop(ctx);
            let _ = debounce_thread.join();
            eprintln!("device_monitor: stopped");
        });

        DeviceMonitorHandle {
            stop_tx: Some(stop_tx),
            thread_handle: Some(thread_handle),
        }
    }

    /// Debounce device change events by type — only forward an event if no
    /// event of the same type arrived within DEBOUNCE_DELAY.
    fn debounce_loop(
        raw_rx: mpsc::Receiver<DeviceChange>,
        out_tx: mpsc::Sender<DeviceChange>,
    ) {
        let mut last_input: Option<Instant> = None;
        let mut last_output: Option<Instant> = None;
        let mut last_list: Option<Instant> = None;

        loop {
            match raw_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(change) => {
                    let now = Instant::now();
                    let (last, kind) = match &change {
                        DeviceChange::DefaultInputChanged => (&mut last_input, "input"),
                        DeviceChange::DefaultOutputChanged => (&mut last_output, "output"),
                        DeviceChange::DeviceListChanged => (&mut last_list, "list"),
                    };

                    let should_send = last
                        .map(|t| now.duration_since(t) >= DEBOUNCE_DELAY)
                        .unwrap_or(true);

                    if should_send {
                        eprintln!("device_monitor: {} change detected (debounced)", kind);
                        let _ = out_tx.send(change);
                    }
                    *last = Some(now);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub mod stub {
    use std::sync::mpsc;

    #[derive(Debug, Clone)]
    pub enum DeviceChange {
        DefaultInputChanged,
        DefaultOutputChanged,
        DeviceListChanged,
    }

    pub struct DeviceMonitorHandle;

    impl DeviceMonitorHandle {
        pub fn stop(self) {}
    }

    impl Drop for DeviceMonitorHandle {
        fn drop(&mut self) {}
    }

    pub fn spawn_monitor(_event_tx: mpsc::Sender<DeviceChange>) -> DeviceMonitorHandle {
        DeviceMonitorHandle
    }
}

#[cfg(target_os = "macos")]
pub use macos::{DeviceChange, DeviceMonitorHandle, spawn_monitor};

#[cfg(not(target_os = "macos"))]
pub use stub::{DeviceChange, DeviceMonitorHandle, spawn_monitor};
