// Bridge codes stay identical to bridge/README.md. Local failures are separate.
export const REMEDIES = Object.freeze({
  unauthorized: '检查 token 来源及回环地址；可能已轮换，勿自行改 token，必要时报告用户。',
  'forbidden-body': '检查 JSON、Content-Type 与请求体大小；按契约组包仍失败时报告用户。',
  'bad-request': '按 error 核对参数、方法和桥契约后重试。',
  'policy-gated': '按 retryAfterMs 等待后重试；spawn-depth-exceeded 应报告用户。',
  'rate-limited': '按 retryAfterMs 等待，不自动重发；先 progress 对账，避免重复投递。',
  'queue-full': '先 dshq watch 等目标消费；紧急改变下一步且目标运行中可用 --steer。',
  'not-found': '用 dshq list 重建现场，核对目标完整 sessionId。',
  'upstream-error': '检查 coordinator 服务；有孤儿 sessionId 时先 progress 对账，勿重复 spawn。',
});

export class CliError extends Error {
  constructor(code, message, { exitCode = 1, advice, ...details } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.payload = { ...details, ok: false, code, error: message,
      advice: advice ?? REMEDIES[code] ?? '检查参数；用 dshq --help 查看用法。' };
  }
}

export function bridgeError(envelope, httpStatus) {
  let advice = REMEDIES[envelope.code] ?? '未知桥错误码；停止并报告契约差异。';
  if (Number.isFinite(envelope.retryAfterMs)) {
    advice += ` retryAfterMs=${envelope.retryAfterMs}（等待 ${Math.ceil(envelope.retryAfterMs / 1000)} 秒）。`;
  }
  if (envelope.code === 'upstream-error' && envelope.sessionId) {
    advice += ' model-select-failed/kickoff-rejected 表示会话可能已创建；核对后 send 补开场或交用户处置。';
  }
  return new CliError(envelope.code, envelope.error, { ...envelope, httpStatus, exitCode: 2, advice });
}
