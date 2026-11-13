export const QUESTS = [
  {
    id: 'object-hunter',
    step: 1,
    title: 'The Object Hunter',
    badge: 'Spotter',
    xp: 100,
    prompt: 'Point your phone at any everyday object — a mug, phone, plant, chair, or shoe.',
    hint: 'Mirage draws a pixel-level polygon mask around every object it spots.',
    sampleSuggestion: 'desk',
    check(data) {
      const objs = Array.isArray(data?.objects) ? data.objects : [];
      if (objs.length >= 1) {
        return {
          passed: true,
          summary: `Locked onto ${objs.length} object${objs.length > 1 ? 's' : ''}: ${objs.slice(0, 3).map((o) => o.name).join(', ')}.`,
        };
      }
      return {
        passed: false,
        summary: 'No distinct objects locked yet — try moving closer or brightening the frame.',
      };
    },
  },
  {
    id: 'word-whisperer',
    step: 2,
    title: 'The Word Whisperer',
    badge: 'Decoder',
    xp: 150,
    prompt: 'Capture any sign, book cover, label, or screen with readable text.',
    hint: 'Mirage includes a built-in CTC text reader that reads cropped regions locally.',
    sampleSuggestion: 'sign',
    check(data) {
      const texts = Array.isArray(data?.text) ? data.text.filter((t) => (t.string || t.text || t.value || '').trim().length > 0) : [];
      if (texts.length >= 1) {
        const words = texts.map((t) => `"${(t.text || t.value).trim()}"`).slice(0, 3).join(', ');
        return {
          passed: true,
          summary: `Decoded ${texts.length} text region${texts.length > 1 ? 's' : ''}: ${words}.`,
        };
      }
      return {
        passed: false,
        summary: 'No text decoded yet — hold steady over bold lettering or try the Street Sign sample.',
      };
    },
  },
  {
    id: 'attribute-scout',
    step: 3,
    title: 'Color & Material Scout',
    badge: 'Alchemist',
    xp: 150,
    prompt: 'Scan something with a vivid color, texture, or material (metal, wood, ceramic, fabric).',
    hint: 'Mirage extracts structured properties like color, shape, and material in one pass.',
    sampleSuggestion: 'desk',
    check(data) {
      const objs = Array.isArray(data?.objects) ? data.objects : [];
      const rich = objs.find((o) => {
        const d = o.description;
        return d && (d.color || d.material || d.shape || d.pattern);
      });
      if (rich) {
        const attrs = Object.entries(rich.description)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        return {
          passed: true,
          summary: `Cataloged "${rich.name}" (${attrs}).`,
        };
      }
      return {
        passed: false,
        summary: 'Try capturing a colorful or textured object clearly in frame.',
      };
    },
  },
  {
    id: 'scene-detective',
    step: 4,
    title: 'Scene Graph Detective',
    badge: 'Cartographer',
    xp: 200,
    prompt: 'Frame 2 or more objects interacting (e.g., a cup on a desk, a sign on a pole).',
    hint: 'Mirage maps spatial relations and builds a mini scene graph on your device.',
    sampleSuggestion: 'desk',
    check(data) {
      const objs = Array.isArray(data?.objects) ? data.objects : [];
      const rels = Array.isArray(data?.relations) ? data.relations : [];
      if (rels.length >= 1 || objs.length >= 2) {
        const detail =
          rels.length >= 1
            ? `Mapped ${rels.length} spatial relation${rels.length > 1 ? 's' : ''}!`
            : `Detected ${objs.length} distinct objects in the same scene!`;
        return { passed: true, summary: detail };
      }
      return {
        passed: false,
        summary: 'Place two items side-by-side or one on top of another and scan again.',
      };
    },
  },
  {
    id: 'multimodal-boss',
    step: 5,
    title: 'Final Boss: Full Perception',
    badge: 'Vision Master',
    xp: 300,
    prompt: 'Pull off a complete multimodal scan: Objects + Text or Relations in a single shot!',
    hint: 'Tip: Frame a notebook with writing next to a mug, or use the Desk / Sign samples.',
    sampleSuggestion: 'sign',
    check(data) {
      const objs = Array.isArray(data?.objects) ? data.objects : [];
      const texts = Array.isArray(data?.text) ? data.text.filter((t) => (t.string || t.text || t.value || '').trim().length > 0) : [];
      const rels = Array.isArray(data?.relations) ? data.relations : [];
      if (objs.length >= 1 && (texts.length >= 1 || rels.length >= 1)) {
        return {
          passed: true,
          summary: `Full sweep! ${objs.length} objects, ${texts.length} text regions, ${rels.length} relations.`,
        };
      }
      return {
        passed: false,
        summary: 'Need at least 1 object plus either readable text or a spatial relation.',
      };
    },
  },
];

export const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'de', label: 'DE', name: 'Deutsch' },
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'es', label: 'ES', name: 'Español' },
  { code: 'it', label: 'IT', name: 'Italiano' },
  { code: 'nl', label: 'NL', name: 'Nederlands' },
  { code: 'pl', label: 'PL', name: 'Polski' },
];
