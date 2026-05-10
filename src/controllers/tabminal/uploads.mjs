import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';

import multer from '@koa/multer';

import { firstFormFieldValue } from './utils.mjs';

const AGENT_ATTACHMENT_FIELD = 'attachments';
const MAX_AGENT_ATTACHMENTS = 8;
const MAX_AGENT_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_TOTAL_SIZE = 25 * 1024 * 1024;
const uploadTempDir = path.join(os.tmpdir(), 'tabminal-agent-uploads');
const uploadAgentAttachments = multer({
    dest: uploadTempDir,
    limits: {
        files: MAX_AGENT_ATTACHMENTS,
        fileSize: MAX_AGENT_ATTACHMENT_SIZE,
        fieldSize: MAX_AGENT_ATTACHMENTS_TOTAL_SIZE
    }
}).any();

async function parseMultipartForm(ctx) {
    await fsPromises.mkdir(uploadTempDir, { recursive: true });
    await uploadAgentAttachments(ctx, async () => {});
    return {
        fields: ctx.request.body || {},
        files: Array.isArray(ctx.request.files) ? ctx.request.files : []
    };
}

function normalizePromptAttachments(files) {
    const rawList = Array.isArray(files)
        ? files
        : (files ? [files] : []);
    return rawList
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
            id: crypto.randomUUID(),
            name: String(
                file.originalFilename
                || file.originalname
                || 'attachment'
            ).trim()
                || 'attachment',
            mimeType: String(file.mimetype || '').trim(),
            size: Number.isFinite(file.size) ? file.size : 0,
            tempPath: String(file.filepath || file.path || '').trim()
        }))
        .filter((file) => file.tempPath);
}

export async function parseAcpBusCommand(ctx) {
    if (ctx.is('multipart')) {
        const { fields, files } = await parseMultipartForm(ctx);
        return {
            type: firstFormFieldValue(fields?.type),
            tabId: firstFormFieldValue(fields?.tabId),
            text: firstFormFieldValue(fields?.text),
            requestId: firstFormFieldValue(fields?.requestId),
            attachments: normalizePromptAttachments(
                files.filter((file) => file?.fieldname === AGENT_ATTACHMENT_FIELD)
            )
        };
    }
    const body = ctx.request.body || {};
    return {
        ...body,
        type: typeof body.type === 'string' ? body.type : ''
    };
}
