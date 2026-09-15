// Wisprnote brand mark. The artwork is a raster with gradient fills, so it is
// served from /logo.png rather than inlined as a path (the previous single-colour
// starburst was an inline SVG). Sizing stays with the caller via `className`.
export function WisprnoteLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Wisprnote"
      draggable={false}
      className={`object-contain select-none${className ? ` ${className}` : ''}`}
    />
  );
}
