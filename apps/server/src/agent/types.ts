/**
 * Shared types of the discovery loop: one Target per identified physical device, walking
 * SCAN -> IDENTIFY -> LINK -> RESEARCH -> DRIVE -> VERIFY -> FORGE -> ARM -> CONTROL.
 */
import type { AgentGuidance, DeviceCardPayload, Driver, Evidence, IrCapture, LinkResultPayload, Polygon, Provenance, PxBox, TargetState, VerifyState } from '@ce/protocol';
import type { DriverIssue } from '../devices/validate';
import type { IrLibrary, MidiProfile } from '../devices/profiles';
import type { IdentityCorrectionAudit } from './identity-correction';

export interface TargetDetection {
  frameId: string;
  detId: string;
  trackId?: string;
  /** the paired device whose camera saw it (the Quest, the iPhone, the sim) */
  sensorDeviceId: string;
  label: string;
  prompt: string;
  score: number;
  box: PxBox;
  polygon?: Polygon;
  width: number;
  height: number;
  /** base64 JPEG of the frame the detection came from (kept for the identify crop and the verify mask) */
  jpeg: string;
  capturedAt: number;
}

export interface LearnedCode extends IrCapture {
  learnId: string;
  /** what the user was asked to press ("全灯") -> hypothesis label; confirmed by the camera later */
  button: string;
  hypothesis: 'fullOn' | 'off' | 'brighter' | 'dimmer' | 'nightLight' | 'warmer' | 'cooler' | 'unknown';
  /** effect the camera saw when it was replayed */
  seen?: string;
  capturedAt: number;
}

export interface Research {
  brief: string;
  provenance: Provenance[];
  profile?: MidiProfile;
  allowedCcs?: Set<number>;
  irLibrary?: IrLibrary;
  learned?: LearnedCode[];
  /** the model that did a web search, if one happened */
  modelId?: string;
}

export interface Target extends AgentGuidance {
  cardId: string;
  runId: string;
  state: TargetState;
  since: number;
  detail?: string;
  detection?: TargetDetection;
  /** who selected it (the Quest, the companion...) */
  selectedBy?: string;
  selection?: { userText?: string; preferDeviceId?: string };
  card?: DeviceCardPayload;
  /** Durable owner-reviewed identity epoch; old setup history cannot cross this boundary. */
  identityRevision?: number;
  identityCorrection?: IdentityCorrectionAudit;
  link?: LinkResultPayload;
  research?: Research;
  driver?: Driver;
  driverIssues?: DriverIssue[];
  verification: Record<string, VerifyState>;
  evidence: Evidence[];
  specId?: string;
  controlCount?: number;
  armed: boolean;
  armId?: string;
  /** tracked level index per step action */
  stepIndex: Record<string, number>;
  /** last value per hack param (for UNDO restore) */
  paramValues: Record<string, number>;
  lastError?: string;
  abort?: AbortController;
}

export const TARGET_STATES_ORDER: TargetState[] = [
  'scanned',
  'identifying',
  'identified',
  'linking',
  'needs-companion',
  'linked',
  'researching',
  'driving',
  'verifying',
  'verified',
  'forging',
  'forged',
  'arming',
  'armed',
  'controlling',
  'failed',
];
