// Reads a QR code from the camera. Mounted only after a tap, so the camera permission is asked
// for then; every track stops when it unmounts. Uses the browser's BarcodeDetector where it reads
// QR codes, else jsQR (loaded only now) on video frames.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n";

/** The part of the BarcodeDetector API used here (not in TypeScript's DOM types). */
interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface DetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}

const SCAN_INTERVAL_MS = 200;

type Reader = (video: HTMLVideoElement) => Promise<string | undefined>;

async function createReader(): Promise<Reader> {
  const Native = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  const formats: string[] = Native ? await Native.getSupportedFormats().catch(() => []) : [];
  if (Native && formats.includes("qr_code")) {
    const detector = new Native({ formats: ["qr_code"] });
    return async (video) => (await detector.detect(video))[0]?.rawValue;
  }
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const { videoWidth: width, videoHeight: height } = video;
    if (!context || width === 0 || height === 0) return undefined;
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return jsQR(image.data, width, height, { inversionAttempts: "dontInvert" })?.data;
  };
}

function cameraErrorText(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("scan.denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("scan.noCamera");
  return t("scan.failed");
}

/**
 * `onCode` gets each code read; it answers whether it was the one wanted (scanning then stops,
 * and the parent unmounts this) or a message to show while scanning goes on.
 */
export function QrScanner(props: { onCode: (text: string) => true | string; onClose: () => void }) {
  const [problem, setProblem] = createSignal<string>();
  const [note, setNote] = createSignal<string>();
  const [starting, setStarting] = createSignal(true);
  let video!: HTMLVideoElement;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    if (video) video.srcObject = null;
  };
  onCleanup(stop);

  const start = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("", "NotFoundError");
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (stopped) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      video.srcObject = media;
      await video.play();
      const read = await createReader();
      setStarting(false);
      const tick = async () => {
        if (stopped) return;
        const text = await read(video).catch(() => undefined);
        if (stopped) return;
        if (text) {
          const answer = props.onCode(text);
          if (answer === true) return stop();
          setNote(answer);
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      void tick();
    } catch (error) {
      stop();
      setStarting(false);
      setProblem(cameraErrorText(error));
    }
  };
  onMount(start);

  // After a camera error (permission denied, say), ask again once the user has sorted it out.
  const retry = () => {
    stopped = false;
    setStarting(true);
    setNote(undefined);
    setProblem(undefined);
    // The video element comes back with the view; start once it is there.
    queueMicrotask(() => void start());
  };

  return (
    <div class="scanner">
      <Show
        when={!problem()}
        fallback={
          <p class="field-error" role="alert">
            {problem()}
          </p>
        }
      >
        <div class="scanner-view">
          <video ref={video} class="scanner-video" muted playsinline />
          <span class="scanner-frame" aria-hidden="true" />
        </div>
        <p class="hint" role="status">
          {starting() ? t("scan.starting") : (note() ?? t("scan.pointAt"))}
        </p>
      </Show>
      <Show
        when={problem()}
        fallback={
          <button type="button" class="btn btn-secondary pair-wide" onClick={props.onClose}>
            {t("scan.stop")}
          </button>
        }
      >
        <button type="button" class="btn btn-secondary pair-wide" onClick={retry}>
          {t("scan.retry")}
        </button>
      </Show>
    </div>
  );
}
