/**
 * COCO-80 classes of the bundled YOLOX detector and what the annotation layer does with them.
 *
 * Only device-like classes ever leave the worker. "person" (class 0) is never boxed, labelled or tracked:
 * an anchor whose best class is "person" is dropped before its coordinates are decoded.
 * Everything else (cups, chairs, plants…)
 * is ignored: the live layer shows devices, nothing else.
 */

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

export const PERSON_CLASS = 0;

/** The category chips of the design (research/06 §"Category chips"). */
export type Category = 'everything' | 'electronics' | 'instruments' | 'lights' | 'remotes';
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'everything', label: 'All' },
  { id: 'lights', label: 'Lights' },
  { id: 'electronics', label: 'Electronics' },
];

export interface DeviceClass {
  /** COCO index */
  cls: number;
  /** what the tag says (our words, not COCO's) */
  label: string;
  categories: Category[];
  /** typical largest dimension, metres: a depth guess from the box size when nothing better is known */
  sizeM: number;
}

/**
 * COCO has no lamp, synth, speaker or air-conditioner class: a synth usually reads as "keyboard", and lights
 * are found by the SAM 3.1 scan only. The Lights chip therefore filters the live layer down to nothing and
 * says so; it exists so one chip set drives both layers.
 */
export const DEVICE_CLASSES: DeviceClass[] = [
  { cls: 62, label: 'Screen', categories: ['electronics'], sizeM: 0.7 },
  { cls: 63, label: 'Laptop', categories: ['electronics'], sizeM: 0.32 },
  { cls: 64, label: 'Mouse', categories: ['electronics'], sizeM: 0.1 },
  { cls: 65, label: 'Remote', categories: ['electronics', 'remotes'], sizeM: 0.17 },
  { cls: 66, label: 'Keyboard', categories: ['electronics', 'instruments'], sizeM: 0.35 },
  { cls: 67, label: 'Phone', categories: ['electronics', 'remotes'], sizeM: 0.15 },
  { cls: 68, label: 'Microwave', categories: [], sizeM: 0.5 },
  { cls: 69, label: 'Oven', categories: [], sizeM: 0.6 },
  { cls: 70, label: 'Toaster', categories: [], sizeM: 0.3 },
  { cls: 72, label: 'Fridge', categories: [], sizeM: 1.7 },
  { cls: 74, label: 'Clock', categories: [], sizeM: 0.3 },
  { cls: 78, label: 'Hair dryer', categories: [], sizeM: 0.25 },
];

const BY_CLASS = new Map(DEVICE_CLASSES.map((d) => [d.cls, d]));

export function deviceClass(cls: number): DeviceClass | undefined {
  return BY_CLASS.get(cls);
}

/** COCO indices the live layer may show for a category chip ('everything' = every device-like class). Never person. */
export function allowedClasses(category: Category): Set<number> {
  const out = new Set<number>();
  for (const d of DEVICE_CLASSES) if (category === 'everything' || d.categories.includes(category)) out.add(d.cls);
  out.delete(PERSON_CLASS);
  return out;
}

export function isCategory(v: string | null | undefined): v is Category {
  return CATEGORIES.some((c) => c.id === v);
}
