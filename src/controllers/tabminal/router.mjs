import Router from '@koa/router';

import { initAuthStore } from '../../auth.mjs';
import { setupFsRoutes } from '../../fs-routes.mjs';
import { registerAcpBusRoutes } from './acp-bus-routes.mjs';
import { registerAuthRoutes } from './auth-routes.mjs';
import { registerPersistenceRoutes } from './persistence-routes.mjs';
import { registerSessionRoutes } from './session-routes.mjs';

export async function createTabminalRouter({
    terminalManager,
    acpManager,
    acpBusManager,
    systemMonitor,
    acpBusReadyPromise,
    serverBootId
}) {
    await initAuthStore();

    const router = new Router();
    registerAuthRoutes(router, serverBootId);
    setupFsRoutes(router);
    registerSessionRoutes(router, {
        terminalManager,
        acpBusManager,
        systemMonitor,
        serverBootId
    });
    registerPersistenceRoutes(router);
    registerAcpBusRoutes(router, {
        acpManager,
        acpBusManager,
        acpBusReadyPromise
    });
    return router;
}
