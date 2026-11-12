/*
  The electronic timer add-on: a PDT-compatible timer (such as pinewood-time) plugged into this device by
  USB. Off unless it's turned on, per device (the timer is plugged into one computer).

  The hook keeps the connection and what the timer is doing, gets it ready for each heat (arm), and hands
  over each race's lane times (onResults) and presses of a pinewood-time button set to "next" (onNext).
*/
import { useCallback, useEffect, useRef, useState } from "react";
import { armCommands, parseLine } from "../shared/pdt";
import { PdtConnection, serialSupported } from "../shared/pdtSerial";

const enabledStorageKey = "pinewood_timer_addon";

export type TimerPhase = "waiting" | "ready" | "gateOpen" | "racing" | "finished";

export type TimerHandlers = {
  onResults: (times: Map<number, number | null>) => void;
  onNext: () => void;
};

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(enabledStorageKey) === "on";
  } catch {
    return false;
  }
}

export function useTimer(handlers: TimerHandlers) {
  const [enabled, setEnabledState] = useState(readEnabled);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<TimerPhase>("waiting");
  const [lanes, setLanes] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [isPinewoodTime, setIsPinewoodTime] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const connRef = useRef<PdtConnection | null>(null);
  const handlersRef = useRef(handlers);
  const lanesRef = useRef<number | null>(null);
  const expectedRef = useRef<number>(0);
  const timesRef = useRef(new Map<number, number | null>());
  const pinewoodTimeRef = useRef(false);
  /** The last heat the timer was readied for, to ready it again if it restarts */
  const armedRef = useRef<string[] | null>(null);
  /** Resolves when the timer says how many lanes it has (right after connecting) */
  const lanesWaiterRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const send = useCallback(async (text: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      await conn.send(text);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const handleLine = useCallback(
    (line: string) => {
      setLog((prev) => [...prev.slice(-29), line]);
      const msg = parseLine(line);
      if (!msg) return;
      switch (msg.kind) {
        case "power":
          // It has just been powered on (or restarted): ready it again for the heat it was readied for
          setPhase("waiting");
          if (armedRef.current) {
            const lanes = armedRef.current;
            void send(armCommands(lanes, lanesRef.current ?? lanes.length).join(""));
          }
          break;
        case "ready":
          setPhase("ready");
          break;
        case "gateOpen":
          setPhase("gateOpen");
          break;
        case "start":
          timesRef.current = new Map();
          setPhase("racing");
          break;
        case "result": {
          timesRef.current.set(msg.lane, msg.seconds);
          const expected = lanesRef.current ?? expectedRef.current;
          if (expected > 0 && timesRef.current.size >= expected) {
            setPhase("finished");
            handlersRef.current.onResults(new Map(timesRef.current));
          }
          break;
        }
        case "next":
          handlersRef.current.onNext();
          break;
        case "version":
          setVersion(msg.version);
          break;
        case "lanes":
          lanesRef.current = msg.lanes;
          setLanes(msg.lanes);
          lanesWaiterRef.current?.();
          break;
        case "text":
          // pinewood-time says its name in its info: point its button at this app, for this session only
          // (not saved, so the timer is back to its own settings when it's next powered on), and stop it
          // typing a key too, which would also press whatever button has the focus here
          if (!pinewoodTimeRef.current && /pinewood-time/i.test(msg.text)) {
            pinewoodTimeRef.current = true;
            setIsPinewoodTime(true);
            void send("#button next\r#button-key none\r");
          }
          break;
        default:
          break;
      }
    },
    [send]
  );

  const attach = useCallback(
    async (conn: PdtConnection) => {
      await conn.open(handleLine, (closeError) => {
        if (connRef.current === conn) connRef.current = null;
        setConnected(false);
        if (closeError) setError(closeError.message);
      });
      connRef.current = conn;
      lanesRef.current = null;
      pinewoodTimeRef.current = false;
      armedRef.current = null;
      setLanes(null);
      setVersion(null);
      setIsPinewoodTime(false);
      setPhase("waiting");
      setError("");
      // Ask who it is and how many lanes it has, and wait (briefly) for the lanes before readying a heat,
      // so the right lanes get masked
      const gotLanes = new Promise<void>((resolve) => {
        lanesWaiterRef.current = resolve;
        window.setTimeout(resolve, 1500);
      });
      await conn.send("VNI");
      await gotLanes;
      lanesWaiterRef.current = null;
      setConnected(true);
    },
    [handleLine]
  );

  const connect = useCallback(async () => {
    setConnecting(true);
    setError("");
    try {
      await attach(await PdtConnection.choose());
    } catch (e) {
      const err = e as Error;
      // Closing the browser's port picker isn't an error worth showing
      if (err.name !== "NotFoundError") setError(err.message);
    } finally {
      setConnecting(false);
    }
  }, [attach]);

  const disconnect = useCallback(async () => {
    const conn = connRef.current;
    connRef.current = null;
    setConnected(false);
    await conn?.close();
  }, []);

  // With the add-on on, reconnect to a timer this site has been allowed before, if it's plugged in
  useEffect(() => {
    if (!enabled || !serialSupported()) return;
    let cancelled = false;
    void (async () => {
      const conn = await PdtConnection.remembered();
      if (!conn || cancelled || connRef.current) return;
      try {
        await attach(conn);
      } catch {
        // in use by another tab or program: leave it to the Connect button
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, attach]);

  useEffect(() => () => void connRef.current?.close(), []);

  const setEnabled = useCallback(
    (on: boolean) => {
      try {
        window.localStorage.setItem(enabledStorageKey, on ? "on" : "off");
      } catch {
        // private browsing: on for this visit only
      }
      setEnabledState(on);
      if (!on) void disconnect();
    },
    [disconnect]
  );

  /** Gets the timer ready for a heat: masks its empty lanes, then resets it */
  const arm = useCallback(
    async (laneAssignments: string[]) => {
      const timerLanes = lanesRef.current ?? laneAssignments.length;
      armedRef.current = laneAssignments;
      expectedRef.current = timerLanes;
      timesRef.current = new Map();
      await send(armCommands(laneAssignments, timerLanes).join(""));
    },
    [send]
  );

  /** Asks the timer to send the last race's results again */
  const resend = useCallback(async () => {
    timesRef.current = new Map();
    await send("Q");
  }, [send]);

  return {
    supported: serialSupported(),
    enabled,
    setEnabled,
    connected,
    connecting,
    error,
    phase,
    lanes,
    version,
    isPinewoodTime,
    log,
    connect,
    disconnect,
    arm,
    resend,
  };
}

export type TimerApi = ReturnType<typeof useTimer>;
