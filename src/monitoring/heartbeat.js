function startHeartbeat(url, logger = console) {
    if (!url) return () => {};
    const controller = new AbortController();
    const send = async () => {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(10000),
                ]),
            });
            if (!response.ok)
                logger.warn(`ハートビート送信失敗: HTTP ${response.status}`);
        } catch {
            if (!controller.signal.aborted)
                logger.error('ハートビートを送信できませんでした');
        }
    };
    void send();
    const timer = setInterval(send, 60000);
    return () => {
        clearInterval(timer);
        controller.abort();
    };
}
module.exports = { startHeartbeat };
