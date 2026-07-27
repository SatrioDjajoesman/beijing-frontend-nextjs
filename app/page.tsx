"use client";

import dynamic from "next/dynamic";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BADGE_CLASS, bevel } from "./bevel";
import { buttonClass } from "./button-style";

const ModelViewer = dynamic(() => import("./ModelViewer"), { ssr: false });

const DEVICE_IDS = ["esp32-1", "esp32-2", "esp32-3"];
const RECONNECT_DELAY_MS = 2000;
const KNOWN_POSITION_ORDER = ["start", "middle", "end"];

type MoistureSensor = {
  raw?: number;
  status?: string;
};

type PressureSensor = {
  ready?: boolean;
  value?: number; // calibrated kPa (data-transfer-calibrated sketch) or raw ADC count (uncalibrated sketch)
  raw?: number;
};

type DeviceData = {
  moisture?: Record<string, MoistureSensor>;
  pressure?: Record<string, PressureSensor>;
};

type DeviceState = {
  data: DeviceData;
  updatedAt: number;
};

// Fixed, representative readings for local preview when no ESP32s or WS
// server are running — spans the full pressure range (low/mid/high) and both
// moisture states so the diagram's gradient/coloring is actually visible.
// Never sent anywhere; only ever loaded into local state via the "Load
// Sample Data" button.
const SAMPLE_DEVICES: Record<string, DeviceData> = {
  "esp32-1": {
    pressure: {
      start: { ready: true, value: 40 },
      middle: { ready: true, value: 101 },
      end: { ready: true, value: 185 },
    },
    moisture: {
      start: { raw: 3400, status: "Dry" },
      middle: { raw: 2900, status: "Dry" },
      end: { raw: 1800, status: "Wet" },
    },
  },
  "esp32-2": {
    pressure: {
      start: { ready: true, value: 185 },
      middle: { ready: true, value: 185 },
      end: { ready: true, value: 185 },
    },
    moisture: {
      start: { raw: 3400, status: "Dry" },
      middle: { raw: 3200, status: "Dry" },
      end: { raw: 3400, status: "Dry" },
    },
  },
  "esp32-3": {
    pressure: {
      start: { ready: true, value: 185 },
      middle: { ready: true, value: 101 },
      end: { ready: true, value: 40 },
    },
    moisture: {
      start: { raw: 3400, status: "Dry" },
      middle: { raw: 1600, status: "Wet" },
      end: { raw: 3400, status: "Dry" },
    },
  },
};

type SignalTrace = {
  column: string;
  raw: number | null;
  rolling: Record<string, { mean: number | null; std: number | null }>;
  rate_of_change: number | null;
  zscore: number | null;
};

type ModelInputTrace = {
  columns: string[];
  values: (number | null)[];
  n_features: number;
};

type ModelOutputTrace = {
  algorithm: string;
  n_estimators: number;
  raw_decision_function: number | null;
  anomaly_score: number | null;
  score_formula: string;
  threshold: number;
  is_anomaly: boolean;
};

type TrendFitTrace = {
  history: { t: string; score: number | null }[];
  slope_per_second: number | null;
  fitted_score_now: number | null;
};

type EtaCalculationTrace = {
  formula: string;
  threshold: number;
  fitted_score_now: number | null;
  slope_per_second: number | null;
  result_seconds: number | null;
  result_label: string;
};

type PredictionTrace = {
  position: string;
  raw_inputs: { moisture: SignalTrace; pressure: SignalTrace };
  cross_position_deltas: Record<string, number | null>;
  wet_duration_seconds: number | null;
  model_input: ModelInputTrace;
  model_output: ModelOutputTrace;
  trend_fit: TrendFitTrace | null;
  eta_calculation: EtaCalculationTrace | null;
  primary_driver_calculation: {
    moisture_zscore_abs: number | null;
    pressure_zscore_abs: number | null;
    winner: string;
  };
};

type PredictionState = {
  anomalyScore: number;
  isAnomaly: boolean;
  eta: string;
  primaryDriver: string;
  trace: PredictionTrace | undefined;
  updatedAt: number;
};

function fmtTrace(value: number | null | undefined, digits = 3): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

type RiskLevel = "unknown" | "ok" | "watch" | "critical";

const RISK_RANK: Record<"ok" | "watch" | "critical", number> = {
  ok: 0,
  watch: 1,
  critical: 2,
};

const RISK_BASE: Record<RiskLevel, string> = {
  unknown: "#f4f4f5",
  ok: "#ffffff",
  watch: "#fbbf24",
  critical: "#dc2626",
};

const RISK_TEXT: Record<RiskLevel, string> = {
  unknown: "text-gray-400",
  ok: "text-black",
  watch: "text-black",
  critical: "text-white",
};

// Risk badges are read-outs, not controls, so they're always shown
// "pressed" (recessed), like an indicator lamp set into a panel.
function riskBevel(level: RiskLevel): CSSProperties {
  return bevel(RISK_BASE[level], true, 2, level === "unknown");
}

const RISK_LABELS: Record<RiskLevel, string> = {
  unknown: "No Data",
  ok: "OK",
  watch: "Watch",
  critical: "Leak Risk",
};

function connectionBadgeClass(connected: boolean): string {
  return `${BADGE_CLASS} bg-white rounded-md border-2 ${connected ? "border-green-600" : "border-black"}`;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

// ---------------------------------------------------------------------------
// Pipe diagram color/geometry helpers — shared by the "View Diagram" mode's
// per-pipe and whole-structure views (see PipesDiagramView below).
// ---------------------------------------------------------------------------

// Matches the HX710B/MPS20N0040D calibration range in
// data-transfer-calibrated: 40 kPa reads as low/leak-risk, 101 kPa is
// standard atmospheric (the steady-state "dry" baseline), 185 kPa is the
// high-pressure ceiling.
const PRESSURE_MIN_KPA = 40;
const PRESSURE_MID_KPA = 101;
const PRESSURE_MAX_KPA = 185;

// Matches DRY_THRESHOLD/WET_THRESHOLD in data-transfer-calibrated — the
// capacitive moisture sensor reads LOWER when wetter.
const MOISTURE_DRY_RAW = 3200;
const MOISTURE_WET_RAW = 2200;

type RGB = [number, number, number];
const COLOR_RED: RGB = [220, 38, 38];
const COLOR_YELLOW: RGB = [234, 179, 8];
const COLOR_BLUE: RGB = [37, 99, 235];
const COLOR_WHITE: RGB = [255, 255, 255];

function lerpRgb(from: RGB, to: RGB, t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const [r, g, b] = from.map((v, i) => Math.round(v + (to[i] - v) * clamped));
  return `rgb(${r}, ${g}, ${b})`;
}

// Blue at/above max, yellow at the atmospheric midpoint, red at/below min —
// traversing gradually between them rather than snapping.
function pressureColor(valueKpa: number): string {
  if (valueKpa <= PRESSURE_MIN_KPA) return `rgb(${COLOR_RED.join(", ")})`;
  if (valueKpa >= PRESSURE_MAX_KPA) return `rgb(${COLOR_BLUE.join(", ")})`;
  if (valueKpa <= PRESSURE_MID_KPA) {
    return lerpRgb(COLOR_RED, COLOR_YELLOW, (valueKpa - PRESSURE_MIN_KPA) / (PRESSURE_MID_KPA - PRESSURE_MIN_KPA));
  }
  return lerpRgb(COLOR_YELLOW, COLOR_BLUE, (valueKpa - PRESSURE_MID_KPA) / (PRESSURE_MAX_KPA - PRESSURE_MID_KPA));
}

function pressureFraction(valueKpa: number): number {
  return Math.min(1, Math.max(0, (valueKpa - PRESSURE_MIN_KPA) / (PRESSURE_MAX_KPA - PRESSURE_MIN_KPA)));
}

function moistureFraction(moisture: MoistureSensor | undefined): number {
  if (!moisture) return 0;
  if (typeof moisture.raw === "number") {
    return Math.min(1, Math.max(0, (MOISTURE_DRY_RAW - moisture.raw) / (MOISTURE_DRY_RAW - MOISTURE_WET_RAW)));
  }
  return moisture.status?.toLowerCase() === "wet" ? 1 : 0;
}

function moistureColor(fraction: number): string {
  return lerpRgb(COLOR_WHITE, COLOR_BLUE, fraction);
}

// Diameters as specified for the physical rig — pipe 1 is the T's left
// horizontal arm, pipe 2 the vertical branch, pipe 3 the right horizontal arm.
const PIPE_DIAMETER_LABEL: Record<string, string> = {
  "esp32-1": "1/2\"",
  "esp32-2": "3/4\"",
  "esp32-3": "1\"",
};

// Rendered pipe body thickness (px), roughly proportional to the real
// diameters above so the structure diagram reads as three different pipes.
const PIPE_THICKNESS_PX: Record<string, number> = {
  "esp32-1": 32,
  "esp32-2": 48,
  "esp32-3": 64,
};

// Display-only label — the underlying device id (e.g. "esp32-1") stays as
// the actual key for websocket matching, state, and model file lookups.
function displayDeviceName(deviceId: string): string {
  const match = deviceId.match(/(\d+)$/);
  return match ? `Pipe ${match[1]}` : deviceId;
}

function riskLevel(pred: PredictionState | undefined): RiskLevel {
  if (!pred) return "unknown";
  if (!pred.isAnomaly) return "ok";
  return pred.eta === "now" ? "critical" : "watch";
}

function positionKeys(data: DeviceData | undefined): string[] {
  const set = new Set<string>([
    ...Object.keys(data?.pressure ?? {}),
    ...Object.keys(data?.moisture ?? {}),
  ]);
  const known = KNOWN_POSITION_ORDER.filter((p) => set.has(p));
  const rest = [...set].filter((p) => !KNOWN_POSITION_ORDER.includes(p)).sort();
  return [...known, ...rest];
}

function worstPosition(
  positions: string[],
  predictions: Record<string, PredictionState> | undefined
): { position: string; level: "ok" | "watch" | "critical" } | null {
  let best: { position: string; level: "ok" | "watch" | "critical" } | null = null;
  for (const position of positions) {
    const level = riskLevel(predictions?.[position]);
    if (level === "unknown") continue;
    if (!best || RISK_RANK[level] > RISK_RANK[best.level]) {
      best = { position, level };
    }
  }
  return best;
}

// Keeps a stable WebSocket connection open for the component's lifetime,
// reconnecting after RECONNECT_DELAY_MS on close. `onMessage` is read via a
// ref so callers can pass a fresh closure each render without retriggering
// the effect (and therefore the connection).
function useReconnectingSocket(
  resolveUrl: () => string,
  onMessage: (data: unknown) => void
) {
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      socket = new WebSocket(resolveUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        socket?.send(JSON.stringify({ type: "hello", role: "viewer" }));
      };

      socket.onmessage = (event) => {
        try {
          onMessageRef.current(JSON.parse(event.data));
        } catch {
          // ignore malformed messages
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((data: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }, []);

  return { connected, send };
}

type AppView = "pipes" | "filtration";

const APP_VIEW_OPTIONS: { value: AppView; label: string }[] = [
  { value: "pipes", label: "Pipes View" },
  { value: "filtration", label: "Filtration View" },
];

// Own dropdown instead of a native <select> so it can share the glass-pill
// button styling — a native select can't be restyled past its trigger box.
function AppViewSwitcher({
  value,
  onChange,
}: {
  value: AppView;
  onChange: (value: AppView) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const current = APP_VIEW_OPTIONS.find((option) => option.value === value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={buttonClass(
          open,
          "px-3 py-1 text-xl uppercase rounded-lg flex items-center gap-2"
        )}
      >
        {current?.label}
        <span className={`text-xs transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          &#9662;
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 bg-white/50 gap-1 p-1 z-20 flex flex-col overflow-hidden rounded-xl border border-zinc-500 backdrop-blur-sm shadow-lg shadow-black/40 min-w-full"
        >
          {APP_VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={buttonClass(
                option.value === value,
                "w-full px-3 py-1 text-sm uppercase text-left whitespace-nowrap rounded-lg"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type FiltrationPh = {
  voltage: number | null;
  value: number | null;
  updated_at: string | null;
};

type FiltrationState = {
  pumpOn: boolean;
  valveOpen: boolean;
  simulated: boolean;
  ph: FiltrationPh;
};

const EMPTY_FILTRATION_STATE: FiltrationState = {
  pumpOn: false,
  valveOpen: false,
  simulated: false,
  ph: { voltage: null, value: null, updated_at: null },
};

export default function Home() {
  const [appView, setAppView] = useState<AppView>("pipes");
  const [filtration, setFiltration] = useState<FiltrationState>(EMPTY_FILTRATION_STATE);
  const [devices, setDevices] = useState<Record<string, DeviceState>>({});
  const [predictions, setPredictions] = useState<
    Record<string, Record<string, PredictionState>>
  >({});
  const [now, setNow] = useState(Date.now());
  const [showModel, setShowModel] = useState(false);
  const [filtrationShowModel, setFiltrationShowModel] = useState(false);
  const [filtrationShowDiagram, setFiltrationShowDiagram] = useState(false);
  const [pipesShowDiagram, setPipesShowDiagram] = useState(false);
  const [pipesDiagramMode, setPipesDiagramMode] = useState<PipesDiagramMode>("single");
  const [pipesDiagramDevice, setPipesDiagramDevice] = useState<string>(DEVICE_IDS[0]);
  const [view, setView] = useState<"sensors" | "calculations">("sensors");

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const { connected } = useReconnectingSocket(
    () =>
      process.env.NEXT_PUBLIC_WS_URL ??
      `ws://${window.location.hostname}:8080`,
    (message) => {
      const msg = message as { type?: string; devices?: Record<string, DeviceData>; device?: string; data?: DeviceData };
      if (msg.type === "snapshot") {
        const snapshot: Record<string, DeviceState> = {};
        for (const [deviceId, data] of Object.entries(msg.devices ?? {})) {
          snapshot[deviceId] = { data, updatedAt: Date.now() };
        }
        setDevices(snapshot);
      } else if (msg.type === "update" && msg.device && msg.data) {
        setDevices((prev) => ({
          ...prev,
          [msg.device as string]: { data: msg.data as DeviceData, updatedAt: Date.now() },
        }));
      }
    }
  );

  const { connected: predictionsConnected } = useReconnectingSocket(
    () =>
      process.env.NEXT_PUBLIC_PREDICTION_WS_URL ??
      `ws://${window.location.hostname}:8090`,
    (message) => {
      const msg = message as {
        type?: string;
        device?: string;
        position?: string;
        anomaly_score?: number;
        is_anomaly?: boolean;
        estimated_time_to_leak?: string;
        primary_driver?: string;
        trace?: PredictionTrace;
      };
      if (msg.type !== "prediction" || !msg.device || !msg.position) return;

      setPredictions((prev) => ({
        ...prev,
        [msg.device as string]: {
          ...prev[msg.device as string],
          [msg.position as string]: {
            anomalyScore: msg.anomaly_score ?? 0,
            isAnomaly: Boolean(msg.is_anomaly),
            trace: msg.trace,
            eta: msg.estimated_time_to_leak ?? "stable",
            primaryDriver: msg.primary_driver ?? "unknown",
            updatedAt: Date.now(),
          },
        },
      }));
    }
  );

  const { connected: filtrationConnected, send: sendFiltrationCommand } = useReconnectingSocket(
    () =>
      process.env.NEXT_PUBLIC_FILTRATION_WS_URL ??
      `ws://${window.location.hostname}:8083`,
    (message) => {
      const msg = message as {
        type?: string;
        pump_on?: boolean;
        valve_open?: boolean;
        simulated?: boolean;
        ph?: FiltrationPh;
      };
      if (msg.type === "snapshot") {
        setFiltration({
          pumpOn: Boolean(msg.pump_on),
          valveOpen: Boolean(msg.valve_open),
          simulated: Boolean(msg.simulated),
          ph: msg.ph ?? { voltage: null, value: null, updated_at: null },
        });
      } else if (msg.type === "state") {
        setFiltration((prev) => ({
          ...prev,
          pumpOn: Boolean(msg.pump_on),
          valveOpen: Boolean(msg.valve_open),
          simulated: Boolean(msg.simulated),
          ph: msg.ph ?? prev.ph,
        }));
      } else if (msg.type === "ph" && msg.ph) {
        setFiltration((prev) => ({ ...prev, ph: msg.ph as FiltrationPh }));
      }
    }
  );

  const toggleSimulation = useCallback(() => {
    sendFiltrationCommand({
      type: "command",
      command: filtration.simulated ? "SIM_OFF" : "SIM_ON",
    });
  }, [sendFiltrationCommand, filtration.simulated]);

  const stepSimulatedPh = useCallback(
    (increase: boolean) => {
      sendFiltrationCommand({ type: "command", command: increase ? "SIM_INC" : "SIM_DEC" });
    },
    [sendFiltrationCommand]
  );

  // Same keybinds as container_final.py's terminal controls (t/l/k) — no
  // need to touch the terminal at all now.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (appView !== "filtration") return;
      const key = event.key.toLowerCase();
      if (key === "t") toggleSimulation();
      else if (key === "l") stepSimulatedPh(true);
      else if (key === "k") stepSimulatedPh(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appView, toggleSimulation, stepSimulatedPh]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white text-black">
      <header className="shrink-0 px-6 py-4 flex items-center justify-between" style={bevel("#e4e4e7", false, 2)}>
        <div className="flex items-center gap-3">
          <AppViewSwitcher value={appView} onChange={setAppView} />
          {appView === "pipes" && (
            <button
              type="button"
              onClick={() => setView((prev) => (prev === "sensors" ? "calculations" : "sensors"))}
              className={buttonClass(false, "px-3 py-1 text-sm uppercase rounded-lg")}
            >
              {view === "sensors" ? "View Calculations" : "View Sensors"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          {appView === "pipes" ? (
            <>
              <span className={connectionBadgeClass(connected)}>
                Sensors: {connected ? "Connected" : "Disconnected"}
              </span>
              <span className={connectionBadgeClass(predictionsConnected)}>
                Predictions: {predictionsConnected ? "Connected" : "Disconnected"}
              </span>
              {view === "sensors" && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setPipesShowDiagram((prev) => {
                        if (!prev) setShowModel(false);
                        return !prev;
                      })
                    }
                    className={buttonClass(pipesShowDiagram, "px-3 py-1 text-sm uppercase rounded-lg")}
                  >
                    {pipesShowDiagram ? "View Data" : "View Diagram"}
                  </button>
                  {pipesShowDiagram && (
                    <button
                      type="button"
                      onClick={() =>
                        setDevices((prev) => {
                          const next = { ...prev };
                          for (const [deviceId, data] of Object.entries(SAMPLE_DEVICES)) {
                            next[deviceId] = { data, updatedAt: Date.now() };
                          }
                          return next;
                        })
                      }
                      className={buttonClass(false, "px-3 py-1 text-sm uppercase rounded-lg")}
                    >
                      Load Sample Data
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setShowModel((prev) => {
                        if (!prev) setPipesShowDiagram(false);
                        return !prev;
                      })
                    }
                    className={buttonClass(showModel, "px-3 py-1 text-sm uppercase rounded-lg")}
                  >
                    View Model
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <span className={connectionBadgeClass(filtrationConnected)}>
                Sensors: {filtrationConnected ? "Connected" : "Disconnected"}
              </span>
              <button
                type="button"
                onClick={() => setFiltrationShowDiagram((prev) => !prev)}
                className={buttonClass(false, "px-3 py-1 text-sm uppercase rounded-lg")}
              >
                {filtrationShowDiagram ? "View Data" : "View Diagram"}
              </button>
              <button
                type="button"
                onClick={() => setFiltrationShowModel((prev) => !prev)}
                className={buttonClass(filtrationShowModel, "px-3 py-1 text-sm uppercase rounded-lg")}
              >
                View Model
              </button>
            </>
          )}
        </div>
      </header>

      {appView === "filtration" && typeof filtration.ph.value === "number" && isPhBad(filtration.ph.value) && (
        <div
          className="shrink-0 px-6 py-2 text-center text-sm font-mono font-bold uppercase text-white"
          style={bevel("#dc2626", true, 2)}
        >
          Filtration System Error - Irregular pH
        </div>
      )}

      {appView === "filtration" ? (
        <FiltrationView
          state={filtration}
          connected={filtrationConnected}
          now={now}
          showModel={filtrationShowModel}
          showDiagram={filtrationShowDiagram}
        />
      ) : view === "calculations" ? (
        <CalculationsView predictions={predictions} />
      ) : pipesShowDiagram ? (
        <PipesDiagramView
          devices={devices}
          mode={pipesDiagramMode}
          onModeChange={setPipesDiagramMode}
          selectedDevice={pipesDiagramDevice}
          onSelectDevice={setPipesDiagramDevice}
        />
      ) : showModel ? (
        // grid-rows-[minmax(0,1fr)]: plain "auto" row sizing lets the row
        // grow to fit the sensor column's content, which defeats the data
        // column's own overflow-y-auto (it never becomes shorter than its
        // content, so it never needs to scroll) and instead clips at the
        // page's outer bound. Pinning the row to the container's actual
        // height keeps the model fixed and forces the data column to
        // scroll internally instead.
        <main className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 grid-rows-[minmax(0,1fr)] gap-6 p-6">
          <ModelViewer />
          <div className="flex flex-col gap-6 min-h-0 overflow-y-auto p-2">
            {DEVICE_IDS.map((deviceId) => (
              <DevicePanel
                key={deviceId}
                deviceId={deviceId}
                state={devices[deviceId]}
                predictions={predictions[deviceId]}
                now={now}
              />
            ))}
          </div>
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
          {DEVICE_IDS.map((deviceId) => (
            <DevicePanel
              key={deviceId}
              deviceId={deviceId}
              state={devices[deviceId]}
              predictions={predictions[deviceId]}
              now={now}
            />
          ))}
        </main>
      )}

      {filtration.simulated && (
        <div
          className="fixed bottom-4 right-4 w-3 h-3 rounded-full bg-green-500"
          title="Simulation mode is ON"
        />
      )}
    </div>
  );
}

function DevicePanel({
  deviceId,
  state,
  predictions,
  now,
}: {
  deviceId: string;
  state: DeviceState | undefined;
  predictions: Record<string, PredictionState> | undefined;
  now: number;
}) {
  const online = Boolean(state);
  const secondsAgo = state ? Math.floor((now - state.updatedAt) / 1000) : null;
  const positions = positionKeys(state?.data);
  const worst = worstPosition(positions, predictions);
  const worstLevel: RiskLevel = worst ? worst.level : "unknown";

  return (
    // shrink-0: without it, this section is a flex child in a
    // height-constrained column (the model+data split) and flexbox will
    // shrink it below its natural content height to make it fit — which,
    // combined with overflow-hidden (here only to clip the rounded
    // corners), clips the panel's own content instead of letting the
    // column's overflow-y-auto do its job.
    <section className="shrink-0 flex flex-col rounded-xl overflow-hidden bg-zinc-400 border border-t-2 border-x-0 border-t-zinc-300 border-x-zinc-500 border-b-zinc-600 shadow shadow-black/20 ring-1 ring-zinc-900">
      <div
        className="px-4 py-3 flex items-center justify-between gap-2 text-white bg-gradient-to-tr from-zinc-800/90 to-zinc-900/50 border-b border-b-zinc-700/80"
      >
        <h2 className="font-bold uppercase">{displayDeviceName(deviceId)}</h2>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-mono uppercase px-2 py-1 rounded-md ${RISK_TEXT[worstLevel]}`}
            style={riskBevel(worstLevel)}
          >
            {worst && worst.level !== "ok"
              ? `${RISK_LABELS[worst.level]}: ${worst.position}`
              : RISK_LABELS[worstLevel]}
          </span>
          <span
            className="text-xs font-mono uppercase px-2 py-1 rounded-md bg-black border border-x-0 border-t-zinc-800 border-b-zinc-400"
          >
            {online ? `${secondsAgo}s ago` : "Offline"}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {positions.length === 0 ? (
          <p className="text-sm font-mono px-1">No data</p>
        ) : (
          positions.map((position) => (
            <PositionCard
              key={position}
              position={position}
              pressure={state?.data.pressure?.[position]}
              moisture={state?.data.moisture?.[position]}
              prediction={predictions?.[position]}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PositionCard({
  position,
  pressure,
  moisture,
  prediction,
}: {
  position: string;
  pressure: PressureSensor | undefined;
  moisture: MoistureSensor | undefined;
  prediction: PredictionState | undefined;
}) {
  const level = riskLevel(prediction);

  return (
    <div className="flex flex-col rounded-lg overflow-hidden border border-x-0 border-t-zinc-800 border-b-zinc-200">
      <div className="flex items-center gap-2 p-2 bg-zinc-500 text-white">
        <span className="text-xs font-bold uppercase shrink-0 w-16 text-center">{position}</span>
        <div className="grid grid-cols-2 gap-2 flex-1">
          <div className="text-white bg-black px-2 py-1 rounded-md border border-x-0 border-t-zinc-800 border-b-zinc-400">
            <div className="text-[10px] font-bold uppercase text-red-500">Pressure (kPa)</div>
            <div className="font-mono text-sm">
              {pressure ? (pressure.ready ? formatNumber(pressure.value) : "Not Ready") : "—"}
            </div>
          </div>
          <div className="text-white bg-black px-2 py-1 rounded-md border border-x-0 border-t-zinc-800 border-b-zinc-400">
            <div className="text-[10px] font-bold uppercase text-blue-500">Moisture</div>
            <div className="font-mono text-sm">
              {moisture ? `${formatNumber(moisture.raw)} (${moisture.status ?? "unknown"})` : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-zinc-500 p-2">
        <div
          className={`px-3 py-2 text-xs font-mono flex items-center justify-between gap-2 rounded-md ${RISK_TEXT[level]}`}
          style={riskBevel(level)}
        >
          <div className="flex items-center gap-3">
            {prediction ? (
              <>
                <span>
                  score {prediction.anomalyScore.toFixed(3)} · eta {prediction.eta}
                </span>
                <span className="uppercase text-[10px]">{prediction.primaryDriver}</span>
              </>
            ) : (
              <span className="text-gray-400">awaiting prediction…</span>
            )}
          </div>
          <span className="text-[10px] font-mono uppercase shrink-0">{RISK_LABELS[level]}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipes diagram view — schematic renderings of the physical pipe rig, either
// one pipe at a time or the full three-pipe "T" structure. Pressure reads as
// a tall pill whose fill level and color (blue -> yellow -> red) track the
// kPa value; moisture reads as a segment of the pipe body itself, tinted
// white -> blue by how wet that section is.
// ---------------------------------------------------------------------------

function PressureGauge({
  value,
  ready,
  orientation = "vertical",
  size = 112,
}: {
  value: number | undefined;
  ready: boolean | undefined;
  orientation?: "vertical" | "horizontal";
  size?: number;
}) {
  const hasValue = typeof value === "number" && ready !== false;
  const clamped = hasValue ? Math.min(PRESSURE_MAX_KPA, Math.max(PRESSURE_MIN_KPA, value as number)) : PRESSURE_MIN_KPA;
  const fraction = hasValue ? pressureFraction(clamped) : 0;
  const color = pressureColor(clamped);
  const vertical = orientation === "vertical";

  // For the vertical orientation, "kPa" is pinned outside the flow (via
  // absolute positioning) so the flex-col centering above is based on the
  // number pill alone, not the wider number+unit row — otherwise the pill
  // ends up centered over the pipe with "kPa" visually pulling it off-axis.
  const numberPill = (
    <span className="px-2 py-0.5 text-xs font-mono rounded-full border-2 border-black bg-white min-w-[2.75rem] text-center block">
      {hasValue ? Math.round(value as number) : "—"}
    </span>
  );

  const badge = vertical ? (
    <div className="relative flex items-center justify-center shrink-0">
      {numberPill}
      <span className="absolute left-full ml-1 text-[10px] font-mono whitespace-nowrap">kPa</span>
    </div>
  ) : (
    <div className="flex items-center gap-1 shrink-0">
      {numberPill}
      <span className="text-[10px] font-mono">kPa</span>
    </div>
  );

  const pill = (
    <div
      className="relative border-2 border-black bg-white overflow-hidden rounded-full shrink-0"
      style={vertical ? { width: 16, height: size } : { width: size, height: 16 }}
    >
      <div
        className="absolute transition-all duration-300"
        style={
          vertical
            ? { left: 0, right: 0, bottom: 0, height: `${fraction * 100}%`, backgroundColor: color }
            : { top: 0, bottom: 0, left: 0, width: `${fraction * 100}%`, backgroundColor: color }
        }
      />
    </div>
  );

  return (
    <div className={`flex ${vertical ? "flex-col" : "flex-row"} items-center gap-1.5`}>
      {vertical ? (
        <>
          {badge}
          {pill}
        </>
      ) : (
        <>
          {pill}
          {badge}
        </>
      )}
    </div>
  );
}

// The gray "aluminum casing" gradient the pipe body and tee joint are drawn
// in — light/base/dark zinc stops, giving a rounded cylindrical highlight
// across the pipe's thickness instead of a flat tone.
const PIPE_CASING_GRADIENT: [string, string, string] = ["#7c7c82", "#a1a1aa", "#52525b"];
const PIPE_CASING_COLOR = PIPE_CASING_GRADIENT[1];

// Direction runs across the pipe's thickness (perpendicular to its run), so
// a horizontal run shades top-to-bottom and a vertical run shades
// left-to-right — either way it reads as a cylinder, not a stripe running
// along the pipe's length.
function pipeCasingGradient(direction: "to bottom" | "to right"): CSSProperties {
  const [light, base, dark] = PIPE_CASING_GRADIENT;
  return { backgroundImage: `linear-gradient(${direction}, ${light}, ${base} 55%, ${dark})` };
}

// A moisture reading is a long colored bar laid along the pipe's run
// direction — its fill goes white -> blue with how wet that section is. The
// number/state readout sits in its own constant-white inner box: for a
// horizontal run it's pegged to one end of the bar (which end is
// caller-configurable via `peg`, since it depends on the arm's orientation
// within the structure); for a vertical run it's dead-centered on the bar
// instead. Either way the readout itself always stays a horizontal row,
// never rotated.
function MoistureSegment({
  moisture,
  orientation = "horizontal",
  peg = "end",
}: {
  moisture: MoistureSensor | undefined;
  orientation?: "horizontal" | "vertical";
  peg?: "start" | "end";
}) {
  const fraction = moistureFraction(moisture);
  const wet = (moisture?.status ?? "").toLowerCase() === "wet";
  const horizontal = orientation === "horizontal";

  const readout = (
    <div className="flex items-center gap-0.5 px-1.5 py-px rounded bg-white border-2 border-black shadow-sm shrink-0">
      <span className="text-[8px] font-mono whitespace-nowrap">
        {typeof moisture?.raw === "number" ? Math.round(moisture.raw) : "—"}
      </span>
      <span
        className={`text-[7px] font-mono uppercase px-1 py-px rounded whitespace-nowrap ${
          wet ? "bg-red-600 text-white" : "bg-zinc-700 text-white"
        }`}
      >
        {moisture?.status ?? "—"}
      </span>
    </div>
  );

  return (
    <div className={`relative w-full h-full flex ${horizontal ? "items-center px-1.5" : "justify-center py-1.5"}`}>
      <div
        className={
          horizontal
            ? `relative w-full h-2/3 rounded-md border-2 border-black flex items-center ${
                peg === "start" ? "justify-start pl-2" : "justify-end pr-2"
              }`
            : "relative h-full w-2/3 rounded-md border-2 border-black"
        }
        style={{ backgroundColor: moistureColor(fraction), transition: "background-color 300ms" }}
      >
        {horizontal ? (
          readout
        ) : (
          // A full-bleed (inset-0) wrapper plus flex centering on both axes
          // pins the readout dead-center on the bar — both dimensions via
          // layout rather than a translate guess, robust regardless of the
          // readout's own (often wider) size.
          <div className="absolute inset-0 flex items-center justify-center">{readout}</div>
        )}
      </div>
    </div>
  );
}

// A run of the pipe body (one physical pipe's worth of segments, or one arm
// of the T structure) rendered as a gray beveled casing split into equal
// moisture slots. Cut with sharp (square) ends, like real pipe stock.
function PipeRun({
  positions,
  moistureData,
  thickness,
  orientation = "horizontal",
  peg = "end",
}: {
  positions: string[];
  moistureData: Record<string, MoistureSensor | undefined>;
  thickness: number;
  orientation?: "horizontal" | "vertical";
  peg?: "start" | "end";
}) {
  const horizontal = orientation === "horizontal";
  // A block-level div fills its parent's width by default, so the
  // horizontal case only needs `height` pinned. There's no equivalent
  // default for height, so the vertical case must explicitly stretch to
  // 100% of its (explicitly-sized) parent or the flex column collapses to
  // its content's natural min-height instead of the intended run length.
  const sizeStyle: CSSProperties = horizontal ? { height: thickness } : { width: thickness, height: "100%" };

  return (
    // No overflow-hidden: the casing is a sharp-edged rectangle (nothing to
    // clip for), and a moisture readout — especially on the narrower
    // vertical stem — can legitimately be wider than the pipe itself, so it
    // needs to be allowed to spill past the casing's edge instead of being
    // cut off.
    <div
      className={`flex ${horizontal ? "flex-row" : "flex-col"}`}
      style={{ ...bevel(PIPE_CASING_COLOR), ...pipeCasingGradient(horizontal ? "to bottom" : "to right"), ...sizeStyle }}
    >
      {positions.map((position) => (
        <div key={position} className="flex-1 min-w-0 min-h-0">
          <MoistureSegment moisture={moistureData[position]} orientation={orientation} peg={peg} />
        </div>
      ))}
    </div>
  );
}

// The valve-like fitting where the three pipes meet: a gray beveled ring
// (matching the casing) around a solid blue core.
function TeeJoint({ size }: { size: number }) {
  const [light, base, dark] = PIPE_CASING_GRADIENT;
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        ...bevel(PIPE_CASING_COLOR),
        backgroundImage: `radial-gradient(circle at 35% 30%, ${light}, ${base} 60%, ${dark})`,
      }}
    >
      <div className="rounded-full bg-blue-600 border-2 border-black" style={{ width: size - 18, height: size - 18 }} />
    </div>
  );
}

// A technical-drawing style dimension line — two end ticks joined by a
// straight line, with the diameter label alongside — used to call out each
// pipe's real-world diameter next to its drawn (not-to-scale) body.
function DimensionBracket({
  label,
  length,
  orientation = "vertical",
  labelSide = "end",
}: {
  label: string;
  length: number;
  orientation?: "vertical" | "horizontal";
  labelSide?: "start" | "end";
}) {
  const vertical = orientation === "vertical";
  // The tick flags always reach toward the pipe, with the solid connecting
  // line on the far side — which side that is flips with labelSide, since
  // "start" puts the bracket to the pipe's left (pipe is on the near/right
  // side, x=10) while "end" puts it to the pipe's right (pipe is on the
  // near/left side, x=2).
  const nearX = labelSide === "start" ? 10 : 2;
  const farX = labelSide === "start" ? 2 : 10;
  const bracket = vertical ? (
    <svg width={12} height={length} className="shrink-0">
      <line x1={nearX} y1={1} x2={farX} y2={1} stroke="black" strokeWidth={2} />
      <line x1={nearX} y1={length - 1} x2={farX} y2={length - 1} stroke="black" strokeWidth={2} />
      <line x1={farX} y1={1} x2={farX} y2={length - 1} stroke="black" strokeWidth={2} />
    </svg>
  ) : (
    // Matches the vertical variant's convention: the solid connecting line
    // sits on the far side (away from the pipe), with the tick "flags"
    // reaching toward it — not the other way around.
    <svg width={length} height={12} className="shrink-0">
      <line x1={1} y1={2} x2={1} y2={10} stroke="black" strokeWidth={2} />
      <line x1={length - 1} y1={2} x2={length - 1} y2={10} stroke="black" strokeWidth={2} />
      <line x1={1} y1={10} x2={length - 1} y2={10} stroke="black" strokeWidth={2} />
    </svg>
  );
  const text = <span className="text-sm font-mono font-bold shrink-0">{label}</span>;

  return (
    <div className={`flex items-center gap-1.5 ${vertical ? "flex-row" : "flex-col"}`}>
      {labelSide === "start" && text}
      {bracket}
      {labelSide === "end" && text}
    </div>
  );
}

// Matches FiltrationDiagram's grid overlay so every schematic diagram in the
// app shares the same graph-paper backdrop.
function DiagramGridBackground() {
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage:
          "linear-gradient(to right, #e5e5e5 1px, transparent 1px), linear-gradient(to bottom, #e5e5e5 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    />
  );
}

function SinglePipeDiagram({ deviceId, state }: { deviceId: string; state: DeviceState | undefined }) {
  const thickness = PIPE_THICKNESS_PX[deviceId] ?? 48;
  const gaugeSize = 130;
  const segWidth = 150;

  return (
    <div className="relative flex-1 flex flex-col items-center justify-center gap-6 p-10 overflow-auto" style={bevel("#ffffff")}>
      <DiagramGridBackground />
      <h2 className="relative text-sm font-bold uppercase tracking-wide">{displayDeviceName(deviceId)}</h2>
      <div className="relative flex items-end gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex" style={{ width: KNOWN_POSITION_ORDER.length * segWidth }}>
            {KNOWN_POSITION_ORDER.map((position) => (
              <div key={position} className="flex-1 flex flex-col items-center gap-1">
                <PressureGauge
                  value={state?.data.pressure?.[position]?.value}
                  ready={state?.data.pressure?.[position]?.ready}
                  size={gaugeSize}
                />
              </div>
            ))}
          </div>
          <div style={{ width: KNOWN_POSITION_ORDER.length * segWidth }}>
            <PipeRun positions={KNOWN_POSITION_ORDER} moistureData={state?.data.moisture ?? {}} thickness={thickness} />
          </div>
        </div>
        <DimensionBracket label={PIPE_DIAMETER_LABEL[deviceId] ?? "—"} length={thickness} orientation="vertical" labelSide="end" />
      </div>
    </div>
  );
}

// Laid out with explicit pixel coordinates (rather than flex rows) so the
// tee joint, the seamless top of the vertical stem, and the dimension
// brackets all line up exactly on the arms' shared centerline — flex
// couldn't guarantee that alignment across three independently-sized rows.
function StructureDiagram({ devices }: { devices: Record<string, DeviceState> }) {
  const pipe1 = devices["esp32-1"];
  const pipe2 = devices["esp32-2"];
  const pipe3 = devices["esp32-3"];

  const segWidth = 130;
  const armWidth = KNOWN_POSITION_ORDER.length * segWidth;
  const armThickness = 56;
  const stemThickness = armThickness;
  // Same total length as an arm (armWidth), just running vertically.
  const stemHeight = armWidth;
  const teeSize = armThickness + 24;
  const gaugeSize = 96;
  const gaugeRowHeight = 150;
  const bracketColWidth = 40;
  const bracketGap = 12;
  const rowGap = 14;

  const casingLeft = bracketColWidth + bracketGap;
  const casingTop = gaugeRowHeight + rowGap;
  const teeCenterX = casingLeft + armWidth;
  const totalWidth = casingLeft + armWidth * 2 + bracketGap + bracketColWidth;
  const stemLeft = teeCenterX - stemThickness / 2;
  const stemTop = casingTop + armThickness;
  const totalHeight = stemTop + stemHeight + rowGap + 24;

  const armSegments = (device: DeviceState | undefined, offsetX: number) =>
    KNOWN_POSITION_ORDER.map((position, i) => (
      <div
        key={position}
        className="absolute flex flex-col items-center justify-end"
        style={{ left: offsetX + segWidth * i, width: segWidth, top: 0, height: gaugeRowHeight }}
      >
        <PressureGauge value={device?.data.pressure?.[position]?.value} ready={device?.data.pressure?.[position]?.ready} size={gaugeSize} />
      </div>
    ));

  return (
    <div className="relative flex-1 flex items-center justify-center p-10 overflow-auto" style={bevel("#ffffff")}>
      <DiagramGridBackground />
      <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
        {armSegments(pipe1, casingLeft)}
        {armSegments(pipe3, casingLeft + armWidth)}

        <div className="absolute" style={{ left: 0, top: casingTop, height: armThickness }}>
          <DimensionBracket label={PIPE_DIAMETER_LABEL["esp32-1"]} length={armThickness} orientation="vertical" labelSide="start" />
        </div>
        <div className="absolute" style={{ left: casingLeft + armWidth * 2 + bracketGap, top: casingTop, height: armThickness }}>
          <DimensionBracket label={PIPE_DIAMETER_LABEL["esp32-3"]} length={armThickness} orientation="vertical" labelSide="end" />
        </div>

        <div className="absolute" style={{ left: casingLeft, top: casingTop, width: armWidth }}>
          <PipeRun positions={KNOWN_POSITION_ORDER} moistureData={pipe1?.data.moisture ?? {}} thickness={armThickness} peg="start" />
        </div>
        <div className="absolute" style={{ left: casingLeft + armWidth, top: casingTop, width: armWidth }}>
          <PipeRun positions={KNOWN_POSITION_ORDER} moistureData={pipe3?.data.moisture ?? {}} thickness={armThickness} />
        </div>

        <div
          className="absolute"
          style={{ left: stemLeft, top: stemTop, width: stemThickness, height: stemHeight, zIndex: 5 }}
        >
          <PipeRun
            positions={KNOWN_POSITION_ORDER}
            moistureData={pipe2?.data.moisture ?? {}}
            thickness={stemThickness}
            orientation="vertical"
          />
        </div>

        <div
          className="absolute"
          style={{ left: teeCenterX - teeSize / 2, top: casingTop + armThickness / 2 - teeSize / 2, zIndex: 10 }}
        >
          <TeeJoint size={teeSize} />
        </div>

        {/* Just enough clearance past the stem's own edge for the moisture
            readout's overflow (now that the readout is small and centered)
            to not collide with these gauges. */}
        <div className="absolute flex flex-col" style={{ left: stemLeft + stemThickness + 10, top: stemTop, height: stemHeight }}>
          {KNOWN_POSITION_ORDER.map((position) => (
            <div key={position} className="flex-1 flex items-center">
              <PressureGauge
                orientation="horizontal"
                value={pipe2?.data.pressure?.[position]?.value}
                ready={pipe2?.data.pressure?.[position]?.ready}
                size={90}
              />
            </div>
          ))}
        </div>

        <div className="absolute flex justify-center" style={{ left: stemLeft, top: stemTop + stemHeight + 6, width: stemThickness }}>
          <DimensionBracket label={PIPE_DIAMETER_LABEL["esp32-2"]} length={stemThickness} orientation="horizontal" labelSide="end" />
        </div>
      </div>
    </div>
  );
}

type PipesDiagramMode = "single" | "structure";

function PipesDiagramView({
  devices,
  mode,
  onModeChange,
  selectedDevice,
  onSelectDevice,
}: {
  devices: Record<string, DeviceState>;
  mode: PipesDiagramMode;
  onModeChange: (mode: PipesDiagramMode) => void;
  selectedDevice: string;
  onSelectDevice: (deviceId: string) => void;
}) {
  return (
    <main className="flex-1 min-h-0 flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onModeChange("single")}
            className={buttonClass(mode === "single", "px-3 py-1 text-sm uppercase rounded-lg")}
          >
            Per Pipe
          </button>
          <button
            type="button"
            onClick={() => onModeChange("structure")}
            className={buttonClass(mode === "structure", "px-3 py-1 text-sm uppercase rounded-lg")}
          >
            Whole Structure
          </button>
        </div>
        {mode === "single" && (
          <div className="flex items-center gap-2">
            {DEVICE_IDS.map((deviceId) => (
              <button
                key={deviceId}
                type="button"
                onClick={() => onSelectDevice(deviceId)}
                className={buttonClass(selectedDevice === deviceId, "px-3 py-1 text-sm uppercase rounded-lg")}
              >
                {displayDeviceName(deviceId)}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "single" ? (
        <SinglePipeDiagram deviceId={selectedDevice} state={devices[selectedDevice]} />
      ) : (
        <StructureDiagram devices={devices} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Filtration view — pump/valve/pH state from the filtration container,
// sourced from esp32/pump_controller.py (see AppView switch in Home).
// ---------------------------------------------------------------------------

const PH_LABELS = [0, 2, 4, 6, 7, 8, 10, 12, 14];

function phLabel(value: number): string {
  if (value < 3) return "Strongly Acidic";
  if (value < 6) return "Acidic";
  if (value <= 8) return "Neutral / Optimal";
  if (value <= 11) return "Alkaline";
  return "Strongly Alkaline";
}

// Anything outside the "Neutral / Optimal" bucket above counts as an
// irregular reading worth surfacing in the header.
function isPhBad(value: number): boolean {
  return value < 6 || value > 8;
}

function PhGauge({ ph, boxed = false }: { ph: FiltrationPh; boxed?: boolean }) {
  const hasValue = typeof ph.value === "number";
  const clamped = hasValue ? Math.min(14, Math.max(0, ph.value as number)) : 7;
  const bad = hasValue && isPhBad(ph.value as number);
  const borderClass = boxed
    ? `rounded-lg border-1 ${bad ? "border-red-600" : "border-black"}`
    : `border-y ${bad ? "border-y-red-600" : "border-y-black"}`;

  return (
    <div className={`p-5 flex flex-col gap-1.5 ${borderClass}`}>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase text-gray-500">pH Level</div>
          <div className="text-2xl font-mono font-bold leading-tight">
            {hasValue ? (ph.value as number).toFixed(2) : "—"}
          </div>
        </div>
        <span className="px-2 py-1 text-xs font-mono uppercase" style={bevel("#ffffff", true, 1)}>
          {hasValue ? phLabel(ph.value as number) : "No Data"}
        </span>
      </div>

      <svg viewBox="0 0 280 30" className="w-full" overflow="visible">
        <defs>
          <linearGradient id="ph-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="21.4%" stopColor="#f97316" />
            <stop offset="35.7%" stopColor="#eab308" />
            <stop offset="42.9%" stopColor="#22c55e" />
            <stop offset="57.1%" stopColor="#22c55e" />
            <stop offset="64.3%" stopColor="#3b82f6" />
            <stop offset="78.6%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <rect x="0" y="4" width="280" height="9" rx="4.5" fill="url(#ph-grad)" stroke="black" strokeWidth="1" />
        {hasValue && (
          <line
            x1={(clamped / 14) * 280}
            y1="0"
            x2={(clamped / 14) * 280}
            y2="17"
            stroke="black"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        )}
        {PH_LABELS.map((tick) => (
          <text
            key={tick}
            x={(tick / 14) * 280}
            y="27"
            textAnchor="middle"
            fontSize="8"
            fontFamily="monospace"
            fill="black"
          >
            {tick}
          </text>
        ))}
      </svg>

      <div className="text-xs font-mono text-gray-500">
        Raw voltage: {typeof ph.voltage === "number" ? `${ph.voltage.toFixed(3)} V` : "—"}
      </div>
    </div>
  );
}

function DeviceStatusBadge({
  label,
  active,
  onLabel,
  offLabel,
}: {
  label: string;
  active: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    // shrink-0 for the same reason as DevicePanel: this can render inside
    // the model+data split's scrollable column, and without it flexbox
    // would shrink it below content height instead of letting the column
    // scroll.
    <section className="shrink-0 flex flex-col rounded-xl overflow-hidden bg-zinc-400 border border-t-2 border-x-0 border-t-zinc-300 border-x-zinc-500 border-b-zinc-600 shadow shadow-black/20 ring-1 ring-zinc-900">
      <div className="px-4 py-3 flex items-center justify-between gap-2 text-white bg-gradient-to-tr from-zinc-800/90 to-zinc-900/50 border-b border-b-zinc-700/80">
        <h2 className="font-bold uppercase">{label}</h2>
      </div>
      <div className="p-3">
        <div
          className={`px-3 py-4 text-center text-xl font-mono font-bold uppercase rounded-md border border-x-0 ${
            active ? "text-white bg-black border-t-zinc-600 border-b-zinc-300" : "text-black bg-white border-t-zinc-600 border-b-zinc-300"
          }`}
        >
          {active ? onLabel : offLabel}
        </div>
      </div>
    </section>
  );
}

// Diagram view — a schematic of the physical filtration container: an RO
// (reverse-osmosis) chamber on top, the pH sensor chamber in the middle, and
// the pump/solenoid-valve outlet at the bottom. Mirrors the physical layout
// so the labels can be tied directly to live state instead of static text.
function FiltrationDiagram({ state }: { state: FiltrationState }) {
  const roActive = state.pumpOn;

  return (
    <div className="relative flex-1 px-20 pt-24 pb-16" style={bevel("#ffffff")}>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(to right, #e5e5e5 1px, transparent 1px), linear-gradient(to bottom, #e5e5e5 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="relative w-full max-w-md mx-auto" style={{ aspectRatio: "400 / 490" }}>
        <svg viewBox="0 0 400 490" className="absolute inset-0 w-full h-full">
          {/* RO chamber — the "base" of an upside-down bottle. Bottom border
              omitted since the neck below tapers directly out of it. */}
          <rect x="155" y="10" width="90" height="110" fill="white" />
          <line x1="155" y1="10" x2="245" y2="10" stroke="black" strokeWidth="2" />
          <line x1="155" y1="10" x2="155" y2="120" stroke="black" strokeWidth="2" />
          <line x1="245" y1="10" x2="245" y2="120" stroke="black" strokeWidth="2" />
          <rect x="190" y="20" width="8" height="90" fill="black" />
          <rect x="202" y="20" width="8" height="90" fill="black" />

          {/* bottle shoulder — tapers straight from the chamber's width down
              to a narrow neck; top/bottom borders omitted (flush with the
              chamber above and the neck below) so only the two slanted walls
              show */}
          <polygon points="155,120 245,120 215,150 185,150" fill="white" />
          <line x1="155" y1="120" x2="185" y2="150" stroke="black" strokeWidth="2" />
          <line x1="245" y1="120" x2="215" y2="150" stroke="black" strokeWidth="2" />

          {/* bottle neck — a narrow spout that pours straight down into the
              container's mouth below */}
          <rect x="185" y="150" width="30" height="20" fill="white" />
          <line x1="185" y1="150" x2="185" y2="170" stroke="black" strokeWidth="2" />
          <line x1="215" y1="150" x2="215" y2="170" stroke="black" strokeWidth="2" />

          {/* flare down into the pH chamber — this is the container's mouth,
              so its top border is shown; bottom border omitted since it's
              flush with the chamber rect below */}
          <polygon points="140,170 260,170 320,210 80,210" fill="white" />
          <path d="M80,210 L140,170 L260,170 L320,210" fill="none" stroke="black" strokeWidth="2" />

          {/* pH chamber — no top/bottom border either, so the side walls read
              as one continuous outline running from the RO taper down through
              to the outlet taper */}
          <rect x="80" y="210" width="240" height="150" fill="white" />
          <line x1="80" y1="210" x2="80" y2="360" stroke="black" strokeWidth="2" />
          <line x1="320" y1="210" x2="320" y2="360" stroke="black" strokeWidth="2" />

          {/* taper down into the outlet neck — no top border, for the same
              reason. Pump nozzle attaches flush to the left edge below. */}
          <polygon points="80,360 320,360 260,400 140,400" fill="white" />
          <path d="M80,360 L140,400 L260,400 L320,360" fill="none" stroke="black" strokeWidth="2" />

          {/* neck */}
          <rect x="140" y="400" width="120" height="30" fill="white" stroke="black" strokeWidth="2" />

          {/* pump — a square nozzle flush against the left taper edge (the
              line from (80,360) to (140,400)), rotated to match its slope */}
          <g transform="rotate(33.7 101 393)">
            <rect
              x="85"
              y="377"
              width="32"
              height="32"
              fill={state.pumpOn ? "black" : "#d4d4d8"}
              stroke="black"
              strokeWidth="2"
            />
          </g>

          {/* solenoid valve */}
          <rect x="160" y="430" width="80" height="45" fill="#d4d4d8" stroke="black" strokeWidth="2" />
          <circle
            cx="200"
            cy="452"
            r="16"
            fill={state.valveOpen ? "#3b82f6" : "#52525b"}
            stroke="black"
            strokeWidth="2"
          />
        </svg>

        <div className="absolute" style={{ left: "70%", top: "4%", width: "34%" }}>
          <div
            className={`px-3 py-2 text-[10px] font-mono uppercase leading-snug rounded-lg border border-black ${
              roActive ? "text-white bg-black" : "text-black bg-white"
            }`}
            //style={bevel(roActive ? "#111111" : "#ffffff", roActive)}
          >
            Reverse Osmosis Chamber
            <br />
            {roActive ? "Active" : "Idle"}
          </div>
        </div>

        <div className="absolute inset-x-0 flex justify-center" style={{ top: "46%" }}>
          <div className="w-3/5 min-w-[200px]">
            <PhGauge ph={state.ph} />
          </div>
        </div>

        {state.pumpOn && (
          <div className="absolute inset-x-0 flex justify-center" style={{ top: "68%" }}>
            <div className="px-3 py-2 text-xs font-mono uppercase text-center rounded-lg border border-black bg-black text-white">
              Extracting Sample
            </div>
          </div>
        )}

        <div className="absolute" style={{ left: "-20%", top: "82%", width: "34%" }}>
          <div
            className={`px-3 py-2 text-xs font-mono uppercase text-center rounded-lg border border-black ${
              state.pumpOn ? "text-white bg-black" : "text-black bg-white"
            }`}
            //style={bevel(state.pumpOn ? "#111111" : "#ffffff", state.pumpOn)}
          >
            Pump {state.pumpOn ? "ON" : "OFF"}
          </div>
        </div>

        <div className="absolute" style={{ left: "64%", top: "90%", width: "38%" }}>
          <div
            className={`px-3 py-2 text-xs font-mono uppercase text-center rounded-lg border border-black ${
              state.valveOpen ? "text-white bg-black" : "text-black bg-white"
            }`}
            //style={bevel(state.valveOpen ? "#111111" : "#ffffff", state.valveOpen)}
          >
            Valve {state.valveOpen ? "Open" : "Closed"}
          </div>
        </div>
      </div>
    </div>
  );
}

function FiltrationDataPanel({
  state,
  connected,
  now,
  stacked,
}: {
  state: FiltrationState;
  connected: boolean;
  now: number;
  stacked: boolean;
}) {
  const updatedAt = state.ph.updated_at ? new Date(state.ph.updated_at).getTime() : null;
  const secondsAgo = updatedAt ? Math.floor((now - updatedAt) / 1000) : null;

  return (
    <div className={`flex-1 grid grid-cols-1 ${stacked ? "" : "md:grid-cols-3"} gap-6 p-2`}>
      <div className={stacked ? "flex flex-col gap-6" : "md:col-span-2 flex flex-col gap-6"}>
        <PhGauge ph={state.ph} boxed />
        <div className="text-xs text-center font-mono uppercase text-gray-500">
          {connected
            ? secondsAgo !== null
              ? `Last pH reading ${secondsAgo}s ago`
              : "Awaiting first pH reading…"
            : "Filtration controller offline"}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <DeviceStatusBadge label="Pump" active={state.pumpOn} onLabel="ON" offLabel="OFF" />
        <DeviceStatusBadge
          label="Solenoid Valve"
          active={state.valveOpen}
          onLabel="OPEN"
          offLabel="CLOSED"
        />
      </div>
    </div>
  );
}

function FiltrationView({
  state,
  connected,
  now,
  showModel,
  showDiagram,
}: {
  state: FiltrationState;
  connected: boolean;
  now: number;
  showModel: boolean;
  showDiagram: boolean;
}) {
  return (
    <main className="flex-1 min-h-0 flex flex-col p-6 gap-6">
      {showModel ? (
        // See the pipes view's equivalent split for why grid-rows is pinned
        // to minmax(0,1fr) instead of left as the default "auto".
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 grid-rows-[minmax(0,1fr)] gap-6">
          <ModelViewer />
          <div className="min-h-0 overflow-y-auto">
            {showDiagram ? (
              <FiltrationDiagram state={state} />
            ) : (
              <FiltrationDataPanel state={state} connected={connected} now={now} stacked />
            )}
          </div>
        </div>
      ) : showDiagram ? (
        <FiltrationDiagram state={state} />
      ) : (
        <FiltrationDataPanel state={state} connected={connected} now={now} stacked={false} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Calculations view — shows every intermediate number the backend computed
// on the way to a prediction, laid out as a left-to-right flow per region:
// raw reading -> engineered features -> the exact vector fed to the model ->
// model output -> trend fit -> ETA formula -> final result. The model itself
// (an ensemble of ~200 decision trees) has no meaningful per-split diagram,
// so it's shown as the exact input vector and exact output score instead —
// the real computation boundary, not a fake tree render.
// ---------------------------------------------------------------------------

function CalculationsView({
  predictions,
}: {
  predictions: Record<string, Record<string, PredictionState>>;
}) {
  const [selectedDevice, setSelectedDevice] = useState<string>(DEVICE_IDS[0]);

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <div className="px-6 py-3 flex items-center gap-2" style={bevel("#e4e4e7", false, 2)}>
        {DEVICE_IDS.map((deviceId) => (
          <button
            key={deviceId}
            type="button"
            onClick={() => setSelectedDevice(deviceId)}
            className={buttonClass(selectedDevice === deviceId, "px-3 py-1 text-sm uppercase rounded-lg")}
          >
            {displayDeviceName(deviceId)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        {KNOWN_POSITION_ORDER.map((position) => (
          <RegionCalculation
            key={position}
            position={position}
            prediction={predictions[selectedDevice]?.[position]}
          />
        ))}
      </div>
    </main>
  );
}

function Node({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-black bg-white px-2 py-1 min-w-[100px]">
      <div className="text-[9px] font-bold uppercase text-gray-500 whitespace-nowrap">{label}</div>
      <div className="font-mono text-xs whitespace-nowrap">{value}</div>
    </div>
  );
}

function Stage({
  label,
  explanation,
  children,
}: {
  label: string;
  explanation: string;
  children: ReactNode;
}) {
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="flex flex-col gap-1 shrink-0">
      <div className="flex items-center justify-between gap-1 border-b border-black pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
        <button
          type="button"
          onClick={() => setShowInfo((prev) => !prev)}
          aria-label={`About ${label}`}
          className={buttonClass(showInfo, "shrink-0 w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold leading-none rounded-full")}
        >
          i
        </button>
      </div>
      {/* The value content stays in the layout (just invisible) so this box's
          size is always driven by it; the explanation is absolutely
          positioned on top and scrolls internally, so toggling it never
          changes the box's dimensions. */}
      <div className="relative flex-1 flex items-center gap-1">
        <div className={`flex items-center gap-1 ${showInfo ? "invisible" : ""}`}>{children}</div>
        {showInfo && (
          <div className="absolute inset-0 p-1 overflow-y-auto rounded border border-black bg-white">
            <p className="text-[15px] leading-tight">{explanation}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// The outer flow row uses items-stretch, so every Stage is stretched to the
// height of the tallest one; Stage's content area is flex-1 + items-center,
// which centers its boxes (whether it's one row or four) inside that
// stretched height. Arrow just centers itself the same way, so it always
// lines up with the middle of whatever it's pointing at either side.
function Arrow() {
  return (
    <div className="flex items-center px-1 transform translate-y-2.5 text-lg font-bold select-none shrink-0">
      &rarr;
    </div>
  );
}

function RegionCalculation({
  position,
  prediction,
}: {
  position: string;
  prediction: PredictionState | undefined;
}) {
  const level = riskLevel(prediction);
  const trace = prediction?.trace;

  return (
    <div className="rounded-md border border-black overflow-hidden">
      <div
        className="px-3 py-2 bg-black flex items-center justify-between text-white"
        //style={bevel("#111111", false)}
      >
        <span className="font-bold uppercase text-sm">{position}</span>
        <span className={`text-xs font-mono uppercase px-2 py-1 ${RISK_TEXT[level]}`} style={riskBevel(level)}>
          {RISK_LABELS[level]}
        </span>
      </div>

      {!prediction || !trace ? (
        <div className="p-4 text-sm font-mono text-gray-400">awaiting calculation data…</div>
      ) : (
        <div className="overflow-x-auto p-4">
          <div className="flex items-stretch gap-2 w-max">
            <Stage
              label="Raw Reading"
              explanation="The exact number the sensor just reported for this position. Everything else on this row is calculated starting from this one number."
            >
              <Node label="Moisture" value={fmtTrace(trace.raw_inputs.moisture.raw, 1)} />
              <Node label="Pressure" value={fmtTrace(trace.raw_inputs.pressure.raw, 1)} />
            </Stage>

            <Arrow />

            <Stage
              label="Rolling Stats"
              explanation="The average and the spread (how much it wobbles) of recent readings, measured over the last 30 seconds, 2 minutes, and 10 minutes. This is what 'normal' looks like right now for this sensor."
            >
              <div className="flex items-start gap-1">
                {(["30s", "2min", "10min"] as const).map((window) => (
                  <div key={window} className="flex flex-col gap-1">
                    <div className="text-[8px] text-center font-bold uppercase text-gray-500">
                      {window}
                    </div>
                    <Node label="M Mean" value={fmtTrace(trace.raw_inputs.moisture.rolling[window]?.mean, 1)} />
                    <Node label="M Std" value={fmtTrace(trace.raw_inputs.moisture.rolling[window]?.std, 2)} />
                    <Node label="P Mean" value={fmtTrace(trace.raw_inputs.pressure.rolling[window]?.mean, 1)} />
                    <Node label="P Std" value={fmtTrace(trace.raw_inputs.pressure.rolling[window]?.std, 2)} />
                  </div>
                ))}
              </div>
            </Stage>

            <Arrow />

            <Stage
              label="Rate of Change"
              explanation="How fast the reading is rising or falling, per second. A steady sensor stays near zero; a developing leak usually pushes this number up."
            >
              <Node label="Moisture" value={fmtTrace(trace.raw_inputs.moisture.rate_of_change, 2)} />
              <Node label="Pressure" value={fmtTrace(trace.raw_inputs.pressure.rate_of_change, 2)} />
            </Stage>

            <Arrow />

            <Stage
              label="Z-Score"
              explanation="How many standard deviations the current reading is from its own recent history. A large number, positive or negative, means this reading is unusual for this specific sensor."
            >
              <Node label="Moisture" value={fmtTrace(trace.raw_inputs.moisture.zscore, 2)} />
              <Node label="Pressure" value={fmtTrace(trace.raw_inputs.pressure.zscore, 2)} />
            </Stage>

            <Arrow />

            <Stage
              label="Cross-Position Delta"
              explanation="The pressure difference between two points along the pipe. A growing gap suggests water is escaping somewhere between those two points."
            >
              {Object.entries(trace.cross_position_deltas).map(([name, value]) => (
                <Node key={name} label={name.replace(/_/g, " ")} value={fmtTrace(value, 2)} />
              ))}
            </Stage>

            <Arrow />

            <Stage
              label="Wet Duration"
              explanation="How many seconds the moisture sensor has been continuously reading 'wet'. A brief splash resets to zero; a real leak keeps this number climbing."
            >
              <Node label="Seconds" value={fmtTrace(trace.wet_duration_seconds, 0)} />
            </Stage>

            <Arrow />

            <Stage
              label={`Model Input (${trace.model_input.n_features})`}
              explanation="Every number calculated so far, bundled together in one fixed order. This exact list is what gets handed to the AI model next. Nothing more, nothing less."
            >
              <div
                className="px-2 py-1 max-h-40 overflow-y-auto min-w-[190px]"
                style={bevel("#ffffff", true, 1)}
              >
                {trace.model_input.columns.map((col, i) => (
                  <div key={col} className="text-[9px] font-mono flex justify-between gap-2">
                    <span className="truncate">{col}</span>
                    <span>{fmtTrace(trace.model_input.values[i], 2)}</span>
                  </div>
                ))}
              </div>
            </Stage>

            <Arrow />

            <Stage
              label="Isolation Forest"
              explanation="An AI model made of 200 decision trees, trained earlier on normal, leak-free data. It compares this moment's numbers to what it learned as normal and outputs one score: how unusual right now is."
            >
              <Node label="Trees" value={String(trace.model_output.n_estimators)} />
              <Node label="Decision Fn" value={fmtTrace(trace.model_output.raw_decision_function, 4)} />
              <Node label="Score = -Fn" value={fmtTrace(trace.model_output.anomaly_score, 4)} />
              <Node label="Threshold" value={fmtTrace(trace.model_output.threshold, 1)} />
            </Stage>

            <Arrow />

            <Stage
              label="Trend Fit"
              explanation="Draws a straight line through the last several anomaly scores to see if they're trending up, down, or staying flat. This line is used to guess where the score is heading next."
            >
              {trace.trend_fit ? (
                <>
                  <Node
                    label={`Slope (${trace.trend_fit.history.length}pt)`}
                    value={fmtTrace(trace.trend_fit.slope_per_second, 5)}
                  />
                  <Node label="Fitted Score" value={fmtTrace(trace.trend_fit.fitted_score_now, 4)} />
                </>
              ) : (
                <Node label="Status" value="collecting data" />
              )}
            </Stage>

            <Arrow />

            <Stage
              label="ETA Formula"
              explanation="Uses the trend line to calculate how many seconds until the score is predicted to cross the 'this counts as a leak' threshold, assuming the current trend keeps going."
            >
              {trace.eta_calculation ? (
                <div className="px-2 py-1 min-w-[220px]" style={bevel("#ffffff", true, 1)}>
                  <div className="text-[9px] font-mono text-gray-500 whitespace-nowrap">
                    {trace.eta_calculation.formula}
                  </div>
                  <div className="text-[10px] font-mono whitespace-nowrap">
                    ({fmtTrace(trace.eta_calculation.threshold, 1)} - {fmtTrace(trace.eta_calculation.fitted_score_now, 4)})
                    {" / "}
                    {fmtTrace(trace.eta_calculation.slope_per_second, 5)}
                  </div>
                  <div className="text-xs font-mono font-bold mt-1">
                    = {trace.eta_calculation.result_label}
                  </div>
                </div>
              ) : (
                <Node label="Status" value="collecting data" />
              )}
            </Stage>

            <Arrow />

            <Stage
              label="Primary Driver"
              explanation="Compares how unusual the moisture reading is versus the pressure reading, and reports whichever one is more abnormal. This explains WHY a region was flagged, not just that it was."
            >
              <Node label="|Moisture Z|" value={fmtTrace(trace.primary_driver_calculation.moisture_zscore_abs, 2)} />
              <Node label="|Pressure Z|" value={fmtTrace(trace.primary_driver_calculation.pressure_zscore_abs, 2)} />
              <Node label="Winner" value={trace.primary_driver_calculation.winner} />
            </Stage>

            <Arrow />

            <Stage
              label="Final Result"
              explanation="The end result for this region, combining everything to the left: is it OK, worth watching, or at risk of leaking right now, plus the estimated time and the reason why."
            >
              <div className={`px-3 py-2 min-w-[150px] ${RISK_TEXT[level]}`} style={riskBevel(level)}>
                <div className="text-xs font-bold uppercase">{RISK_LABELS[level]}</div>
                <div className="text-[10px] font-mono mt-1 whitespace-nowrap">eta {prediction.eta}</div>
                <div className="text-[10px] font-mono uppercase whitespace-nowrap">{prediction.primaryDriver}</div>
              </div>
            </Stage>
          </div>
        </div>
      )}
    </div>
  );
}
