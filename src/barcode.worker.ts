/// <reference lib="webworker" />
// zxing-wasm in a Web Worker. The .wasm file is bundled by Vite and served
// from this origin; the library default would load it from jsDelivr.

import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

const options: ReaderOptions = {
  formats: ["Code128", "DataMatrix", "QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  maxNumberOfSymbols: 4,
};

export interface WorkerHit {
  format: string;
  text: string;
  orientation: number;
  position: { x: number; y: number }[];
}

self.onmessage = async (ev: MessageEvent<{ id: number; image: ImageData }>) => {
  const { id, image } = ev.data;
  try {
    const results = await readBarcodes(image, options);
    const hits: WorkerHit[] = results
      .filter((r) => r.isValid)
      .map((r) => ({
        format: r.format,
        text: r.text,
        orientation: r.orientation,
        position: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft],
      }));
    self.postMessage({ id, hits });
  } catch (e) {
    self.postMessage({ id, hits: [], error: String(e) });
  }
};
