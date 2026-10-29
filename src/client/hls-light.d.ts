// hls.js ships no types for its light build; it has the same API minus subtitles, alt audio and DRM.
declare module "hls.js/light" {
  export { default } from "hls.js";
}
