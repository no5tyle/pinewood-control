// The parts of the Web Serial API (Chrome and Edge) the timer add-on uses
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}
interface Serial extends EventTarget {
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}
interface Navigator {
  readonly serial?: Serial;
}
