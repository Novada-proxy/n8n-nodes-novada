import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

export const SCRAPER_BASE_URL = 'https://scraper.novada.com';
export const MANAGEMENT_BASE_URL = 'https://api-m.novada.com';
export const UNBLOCKER_BASE_URL = 'https://webunlocker.novada.com';

export function toForm(fields: IDataObject): string {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null || value === '') continue;
		form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
	}
	return form.toString();
}

export function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

// Novada returns HTTP 200 for failures and reports them in the body `code` (0 = success)
export function assertSuccess(this: IExecuteFunctions, body: unknown, itemIndex: number): void {
	if (body === null || typeof body !== 'object' || !('code' in body)) return;
	const { code, msg, data } = body as IDataObject;
	if (code === 0) return;
	const detail = (data as IDataObject | null)?.msg_detail ?? (data as IDataObject | null)?.msg;
	throw new NodeApiError(this.getNode(), body as JsonObject, {
		itemIndex,
		message: `Novada API error ${String(code)}: ${String(msg ?? 'Unknown error')}`,
		description: detail ? String(detail) : undefined,
	});
}

// Retries transient connection failures (reset, TLS handshake, timeout). Only use for
// idempotent calls: retrying task creation could start a duplicate, billed task.
// The last failure is passed through unchanged; callers wrap it in NodeApiError.
export async function withNetworkRetry<T>(
	attempts: number,
	fn: () => Promise<T>,
	delayMs = 2000,
): Promise<T> {
	return await fn().catch(async (error: unknown) => {
		if (attempts <= 1) return await Promise.reject(error);
		await sleep(delayMs);
		return await withNetworkRetry(attempts - 1, fn, delayMs + 2000);
	});
}

export async function novadaRequest(
	this: IExecuteFunctions,
	itemIndex: number,
	baseURL: string,
	path: string,
	form: IDataObject = {},
	qs?: IDataObject,
	attempts = 1,
): Promise<IDataObject> {
	// n8n's outbound egress check parses `url` on its own, so it must be absolute (no baseURL)
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${baseURL}${path}`,
		qs,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: toForm(form),
		// Novada may answer 5xx with a JSON body; read it so assertSuccess can show the real `msg`
		ignoreHttpStatusErrors: true,
	};

	let response: unknown;
	try {
		// HTTP status errors are ignored above, so anything thrown here is a connection failure
		response = await withNetworkRetry(
			attempts,
			async () => await this.helpers.httpRequestWithAuthentication.call(this, 'novadaApi', options),
		);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
	}

	const body = parseBody(response);
	assertSuccess.call(this, body, itemIndex);
	return body as IDataObject;
}
