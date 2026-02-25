window.AppError = (() => {
  function parse(error) {
    const status = Number(error?.status || error?.context?.status || 0);
    const code = error?.code || "";
    const requestId = error?.request_id || "";
    const message = error?.message || "요청 처리 중 오류가 발생했습니다.";

    if (status === 401) return { ...base(message, code, requestId), userMessage: "로그인이 만료되었습니다. 다시 로그인해 주세요." };
    if (status === 403) return { ...base(message, code, requestId), userMessage: "권한이 없습니다." };
    if (status === 429) return { ...base(message, code, requestId), userMessage: "요청이 많습니다. 잠시 후 다시 시도해 주세요." };
    if (status >= 500) return { ...base(message, code, requestId), userMessage: "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." };
    return { ...base(message, code, requestId), userMessage: message };
  }

  function base(message, code, requestId) {
    return {
      rawMessage: String(message || ""),
      code: String(code || ""),
      requestId: String(requestId || ""),
      userMessage: String(message || ""),
    };
  }

  function toConsole(context, error) {
    const parsed = parse(error);
    console.error(`[${context}]`, {
      message: parsed.rawMessage,
      code: parsed.code,
      requestId: parsed.requestId,
      error,
    });
    return parsed;
  }

  return { parse, toConsole };
})();
