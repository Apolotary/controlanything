/**
 * Companion web app (Mac, Chrome). Two faces:
 *   /companion/             the workbench (pairing, executors, agent work log, evidence)
 *   /companion/?spike=midi  the standalone MIDI spike (identity request + CC sweep; no server or agent needed)
 */
import './style.css';

const spike = new URLSearchParams(location.search).get('spike');

if (spike === 'midi') {
  void import('./spike/midiSpike').then((m) => m.bootSpike());
} else {
  void import('./workbench').then((m) => m.bootWorkbench());
}
