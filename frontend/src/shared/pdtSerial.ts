/*
  A PDT timer on a serial port, through the browser's Web Serial API (Chrome and Edge on a computer).
  The timer plugs in by USB and shows up as a serial port; the browser asks the user to pick it once, and
  remembers it for this site after that.
*/
import { LineBuffer } from "./pdt";

export function serialSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.serial);
}

/** A phone or tablet: a timer can't be plugged in there, even where the browser has serial support */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  // Either sign is enough: the browser saying it's mobile, or a phone or tablet in its user agent
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return uaData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Whether this device can use the timer add-on: a computer with a browser that has Web Serial */
export function timerAvailable(): boolean {
  return serialSupported() && !isMobileDevice();
}

export class PdtConnection {
  private port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(port: SerialPort) {
    this.port = port;
  }

  /** Asks the user to choose the timer's port */
  static async choose(): Promise<PdtConnection> {
    if (!navigator.serial) throw new Error("This browser can't use serial ports.");
    return new PdtConnection(await navigator.serial.requestPort());
  }

  /** A port the user has chosen before, if it's plugged in */
  static async remembered(): Promise<PdtConnection | null> {
    if (!navigator.serial) return null;
    const ports = await navigator.serial.getPorts();
    return ports.length ? new PdtConnection(ports[0]) : null;
  }

  /** Opens the port and reads lines until it's closed or unplugged, then calls onClosed */
  async open(onLine: (line: string) => void, onClosed: (error?: Error) => void): Promise<void> {
    // The speed doesn't matter over USB, but a PDT on a real serial port runs at 9600
    await this.port.open({ baudRate: 9600 });
    void this.readLoop(onLine, onClosed);
  }

  private async readLoop(onLine: (line: string) => void, onClosed: (error?: Error) => void) {
    const decoder = new TextDecoder();
    const lines = new LineBuffer();
    let failure: Error | undefined;
    try {
      while (this.port.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            for (const line of lines.push(decoder.decode(value, { stream: true }))) onLine(line);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (e) {
      failure = e as Error;
    }
    onClosed(this.closed ? undefined : failure ?? new Error("The timer was disconnected."));
  }

  /** Sends text to the timer. Writes queue up, so two at once don't fight over the port */
  send(text: string): Promise<void> {
    const write = async () => {
      if (!this.port.writable) throw new Error("The timer isn't connected.");
      const writer = this.port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(text));
      } finally {
        writer.releaseLock();
      }
    };
    const done = this.writing.then(write, write);
    this.writing = done.catch(() => undefined);
    return done;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    try {
      await this.port.close();
    } catch {
      // already closed
    }
  }
}
