// Minimal typing for pngjs (installed as a dependency of qrcode); only what the scripts use.
declare module 'pngjs' {
  export class PNG {
    constructor(opts?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buf: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}
