import { config } from '../../config.mjs';

export function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}

export function firstFormFieldValue(value) {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
}

export function parseQueryBoolean(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
        || normalized === 'true'
        || normalized === 'yes';
}
