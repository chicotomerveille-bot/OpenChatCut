// FR dictionary assembly: field files are split the same way as the English
// dictionary (see dict/en/index.ts) so both can be maintained screen by screen.
// A key missing here is not a hole in the UI: t() falls back to the English
// entry for that key (dictRegistry.fetchDicts('fr')), never to Chinese.
import editor from './editor';
import review from './review';
import timeline from './timeline';
import topbar from './topbar';

export const FR: Record<string, string> = Object.assign(
  {},
  editor, review, timeline, topbar,
);
