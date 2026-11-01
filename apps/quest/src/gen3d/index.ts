/** Public surface of the gen3d renderer (used by the HUD and by the gallery). */
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/share-tech-mono/400.css';

export { SpecObject, formatValue, normalize, fromT, quantize, range, type GenEvents, type SpecObjectOptions } from './build';
export { MaterialClock, HoloMaterial, buildMaterial, ROLE_ORDER } from './materials';
export { Label } from './text';
export { PathObject } from './path';
export { buildGeometry } from './geometry';
export { MouseCursor, handCursor, newCursor, type Cursor, type CursorHand, type HandInput } from './interact';
export { Emitter, ConsoleSink, MultiSink, RateLimitedSink, toControlEventPayload, type EventSink } from './events';
export { UiAudio, type Cue } from './audio';
export { damp, ease, Tweens, OneEuro3, FlashGovernor } from './anim';
