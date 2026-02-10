const CLUSTER_DEBUG_STORAGE_KEY = 'tabminal_cluster_debug';

function resolveClusterDebugFlag() {
    const query = new URLSearchParams(window.location.search).get('clusterDebug');
    if (query === '1' || query === 'true') return true;
    if (query === '0' || query === 'false') return false;
    return localStorage.getItem(CLUSTER_DEBUG_STORAGE_KEY) === '1';
}

export function createClusterDebug() {
    const enabled = resolveClusterDebugFlag();

    const clusterDebug = (...args) => {
        if (!enabled) return;
        console.log('[ClusterDebug]', ...args);
    };

    window.TabminalDebug = window.TabminalDebug || {};
    window.TabminalDebug.setClusterDebug = (value) => {
        const on = !!value;
        if (on) {
            localStorage.setItem(CLUSTER_DEBUG_STORAGE_KEY, '1');
        } else {
            localStorage.removeItem(CLUSTER_DEBUG_STORAGE_KEY);
        }
        window.TabminalDebug.clusterDebugEnabled = on;
    };
    window.TabminalDebug.clusterDebugEnabled = enabled;

    return { clusterDebug, enabled };
}
