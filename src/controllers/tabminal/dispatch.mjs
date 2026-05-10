let tabminalHttpHandler = null;

export function setTabminalHttpHandler(handler) {
    tabminalHttpHandler = typeof handler === 'function' ? handler : null;
}

async function dispatchTabminal(ctx, next) {
    if (!tabminalHttpHandler) {
        ctx.status = 503;
        ctx.body = { error: 'Tabminal is starting' };
        return;
    }
    await tabminalHttpHandler(ctx, next);
}

export const actions = [
    {
        path: '*',
        method: '*',
        priority: -8970,
        process: dispatchTabminal
    }
];
