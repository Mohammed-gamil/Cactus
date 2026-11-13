const PALETTE = [
  { fill: 'rgba(30, 127, 92, 0.24)', stroke: '#1E7F5C', pill: '#1E7F5C' },
  { fill: 'rgba(217, 107, 39, 0.24)', stroke: '#D96B27', pill: '#D96B27' },
  { fill: 'rgba(36, 99, 235, 0.24)', stroke: '#2463EB', pill: '#2463EB' },
  { fill: 'rgba(180, 83, 9, 0.24)', stroke: '#B45309', pill: '#B45309' },
  { fill: 'rgba(13, 148, 136, 0.24)', stroke: '#0D9488', pill: '#0D9488' },
];

export function renderOverlays(canvas, data, selectedObjectId = null) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data) return;

  const objects = Array.isArray(data.objects) ? data.objects : [];
  const texts = Array.isArray(data.text) ? data.text : [];

  // 1. Draw segmentation masks & bounding boxes
  objects.forEach((obj, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const isSelected = selectedObjectId !== null && obj.id === selectedObjectId;
    const scaleX = w / 1000;
    const scaleY = h / 1000;

    // Polygon mask
    if (Array.isArray(obj.mask) && obj.mask.length >= 6) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(obj.mask[0] * scaleX, obj.mask[1] * scaleY);
      for (let i = 2; i < obj.mask.length; i += 2) {
        ctx.lineTo(obj.mask[i] * scaleX, obj.mask[i + 1] * scaleY);
      }
      ctx.closePath();
      ctx.fillStyle = isSelected ? color.fill.replace('0.24', '0.42') : color.fill;
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 1.75;
      ctx.strokeStyle = color.stroke;
      ctx.stroke();
      ctx.restore();
    }

    // Bounding box & label
    if (Array.isArray(obj.bbox) && obj.bbox.length === 4) {
      const [x1, y1, x2, y2] = obj.bbox;
      const bx = x1 * scaleX;
      const by = y1 * scaleY;
      const bw = Math.max(4, (x2 - x1) * scaleX);
      const bh = Math.max(4, (y2 - y1) * scaleY);

      ctx.save();
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.setLineDash(isSelected ? [] : [6, 4]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();

      const scorePct = typeof obj.score === 'number' ? ` ${Math.round(obj.score * 100)}%` : '';
      const label = `${obj.name || 'object'}${scorePct}`;
      ctx.save();
      ctx.font = '600 12px "Plus Jakarta Sans", system-ui, sans-serif';
      const padX = 8;
      const tw = ctx.measureText(label).width + padX * 2;
      const th = 22;
      const lx = Math.max(4, Math.min(w - tw - 4, bx));
      const ly = by - th - 4 >= 4 ? by - th - 4 : by + 4;

      ctx.fillStyle = color.pill;
      roundRect(ctx, lx, ly, tw, th, 6);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + padX, ly + th / 2 + 0.5);
      ctx.restore();
    }
  });

  // 2. Draw OCR text boxes
  texts.forEach((t) => {
    const box = t.bbox || t.box;
    const str = (t.text || t.value || '').trim();
    if (!Array.isArray(box) || box.length !== 4 || !str) return;

    const scaleX = w / 1000;
    const scaleY = h / 1000;
    const bx = box[0] * scaleX;
    const by = box[1] * scaleY;
    const bw = Math.max(4, (box[2] - box[0]) * scaleX);
    const bh = Math.max(4, (box[3] - box[1]) * scaleY);

    ctx.save();
    ctx.fillStyle = 'rgba(250, 247, 242, 0.22)';
    ctx.strokeStyle = '#1A1917';
    ctx.lineWidth = 2;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);

    ctx.font = '600 11px "JetBrains Mono", monospace';
    const padX = 6;
    const tw = ctx.measureText(str).width + padX * 2;
    const th = 20;
    const lx = Math.max(4, Math.min(w - tw - 4, bx));
    const ly = by + bh + 4 + th <= h ? by + bh + 4 : Math.max(4, by - th - 4);

    ctx.fillStyle = '#1A1917';
    roundRect(ctx, lx, ly, tw, th, 5);
    ctx.fill();
    ctx.fillStyle = '#FAF7F2';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, lx + padX, ly + th / 2 + 0.5);
    ctx.restore();
  });
}

export function hitTestObject(data, normX, normY) {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  // Prefer smaller / tighter bounding boxes on tap
  const hits = objects.filter((obj) => {
    if (!Array.isArray(obj.bbox) || obj.bbox.length !== 4) return false;
    const [x1, y1, x2, y2] = obj.bbox;
    return normX >= x1 && normX <= x2 && normY >= y1 && normY <= y2;
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
    const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
    return areaA - areaB;
  });
  return hits[0];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
