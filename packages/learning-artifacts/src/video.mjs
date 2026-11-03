import { escape } from './documents.mjs';
import { requireThat } from './model.mjs';

/** Each duration comes from ffprobe on real audio, never estimated from text length. */
export function videoComposition(plan, audio) {
  requireThat(audio.length === plan.scenes.length && audio.length > 0, 'INVALID_AUDIO', 'Every scene needs narration');
  let start = 0;
  const timeline = plan.scenes.map((scene, i) => {
    const duration = audio[i].duration;
    requireThat(Number.isFinite(duration) && duration > 0 && duration <= 600, 'INVALID_AUDIO', 'Invalid scene duration');
    const entry = { start, duration: duration + 0.35, audioDuration: duration, path: `audio/scene-${i + 1}.mp3`, scene };
    start += entry.duration; return entry;
  });
  requireThat(start <= 1800, 'INVALID_AUDIO', 'Video exceeds 30 minutes');
  // Only generated relative audio names. Model text is escaped; it cannot add HTML/scripts/network requests.
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=1920, height=1080"><title>${escape(plan.title)}</title><style>
  @font-face{font-family:'LearningXXX Korean';src:local('Apple SD Gothic Neo'),local('Noto Sans CJK KR')}*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;background:#101b32;color:#f7f9ff;font-family:'LearningXXX Korean',sans-serif}.scene{position:absolute;inset:0;padding:100px 120px;background:#101b32}.label{font-size:30px;color:#86b7ff;letter-spacing:2px}h1{font-size:62px;line-height:1.3;margin:40px 0 60px;overflow-wrap:anywhere}li{font-size:38px;line-height:1.5;margin:24px 0;overflow-wrap:anywhere}footer{position:absolute;left:120px;bottom:55px;font-size:22px;color:#a8b9d4}
  </style></head><body><div id="root" data-composition-id="root" data-no-timeline data-width="1920" data-height="1080" data-start="0" data-duration="${start}">
  ${timeline.map((t, i) => `<div class="clip scene" id="scene-${i + 1}" data-start="${t.start}" data-duration="${t.duration}" data-track-index="0"><div class="label">강의 설명 · ${i + 1} / ${timeline.length}</div><h1>${escape(t.scene.title)}</h1><ul>${t.scene.bullets.map((b) => `<li>${escape(b)}</li>`).join('')}</ul><footer>AI가 만든 설명 · 강의 원문과 함께 확인</footer></div><audio id="narration-${i + 1}" class="clip" src="${t.path}" data-start="${t.start}" data-duration="${t.audioDuration}" data-track-index="1"></audio>`).join('\n')}
  </div></body></html>`;
  return { html, duration: start, timeline: timeline.map(({ scene, ...entry }) => entry) };
}
