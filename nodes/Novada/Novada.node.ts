import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	assertSuccess,
	MANAGEMENT_BASE_URL,
	novadaRequest,
	parseBody,
	SCRAPER_BASE_URL,
	toForm,
	UNBLOCKER_BASE_URL,
	withNetworkRetry,
} from './GenericFunctions';

// Programmatic style: an async Scraper API run chains create task → poll status → download result,
// which the declarative routing model cannot express.

// Attempts for read-only calls, which are safe to repeat after a dropped connection
const READ_ATTEMPTS = 3;

function toItems(data: unknown, itemIndex: number, split: boolean): INodeExecutionData[] {
	if (split && Array.isArray(data)) {
		return data.map((record) => ({
			json: (record !== null && typeof record === 'object'
				? record
				: { value: record }) as IDataObject,
			pairedItem: { item: itemIndex },
		}));
	}
	const json = Array.isArray(data) ? { results: data } : ((data as IDataObject) ?? {});
	return [
		{ json: typeof json === 'object' ? json : { value: json }, pairedItem: { item: itemIndex } },
	];
}

function parseJsonParameter(
	this: IExecuteFunctions,
	value: unknown,
	name: string,
	itemIndex: number,
): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(this.getNode(), `"${name}" must be valid JSON`, { itemIndex });
	}
}

function toNovadaDate(value: string): string {
	return value.replace('T', ' ').slice(0, 19);
}

export class Novada implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Novada',
		name: 'novada',
		icon: { light: 'file:novada.svg', dark: 'file:novada.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Scrape websites and get structured data from Google, Amazon, YouTube and more with Novada',
		defaults: {
			name: 'Novada',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'novadaApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Scraper API', value: 'scraper' },
					{ name: 'Web Unblocker', value: 'webUnblocker' },
				],
				default: 'scraper',
			},

			// ----------------------------------
			//         Scraper API
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['scraper'] } },
				options: [
					{
						name: 'Get Task Result',
						value: 'getResult',
						description: 'Get the result of a finished scraping task',
						action: 'Get task result',
					},
					{
						name: 'Get Task Status',
						value: 'getStatus',
						description: 'Get the status of one or more scraping tasks',
						action: 'Get task status',
					},
					{
						name: 'Run Scraper',
						value: 'run',
						description: 'Run a Novada scraper and return its data',
						action: 'Run a scraper',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Platform',
				name: 'scraperName',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. amazon.com',
				description:
					'Value of scraper_name for the target platform, as listed in the Novada Scraper API documentation',
				displayOptions: { show: { resource: ['scraper'], operation: ['run'] } },
			},
			{
				displayName: 'Scraper ID',
				name: 'scraperId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. amazon_product_keywords',
				description:
					'Value of scraper_id for the scenario to run, as listed in the Novada Scraper API documentation',
				displayOptions: { show: { resource: ['scraper'], operation: ['run'] } },
			},
			{
				displayName: 'Parameter Style',
				name: 'parameterStyle',
				type: 'options',
				options: [
					{
						name: 'Scraper Params (JSON Array)',
						value: 'scraperParams',
						description: 'For e-commerce, social media and video scenarios',
					},
					{
						name: 'Top-Level Fields (JSON Object)',
						value: 'flat',
						description: 'For search engine scenarios such as google_search',
					},
				],
				default: 'scraperParams',
				displayOptions: { show: { resource: ['scraper'], operation: ['run'] } },
			},
			{
				displayName: 'Scraper Params',
				name: 'scraperParams',
				type: 'json',
				required: true,
				default: '[\n  {\n    "keyword": "coffee",\n    "max_pages": "1"\n  }\n]',
				description:
					'JSON array of inputs. Each object is one input; field names depend on the scraper.',
				displayOptions: {
					show: { resource: ['scraper'], operation: ['run'], parameterStyle: ['scraperParams'] },
				},
			},
			{
				displayName: 'Search Fields',
				name: 'flatParams',
				type: 'json',
				required: true,
				default: '{\n  "q": "coffee shops",\n  "json": "1"\n}',
				description:
					'JSON object whose fields are sent as-is, for example q, gl and hl. For search scrapers keep the output format field set to "1" to get JSON results.',
				displayOptions: {
					show: { resource: ['scraper'], operation: ['run'], parameterStyle: ['flat'] },
				},
			},
			{
				displayName: 'Wait for Result',
				name: 'waitForResult',
				type: 'boolean',
				default: true,
				description:
					'Whether to wait until an asynchronous task finishes and return its data. If off, the task ID is returned immediately.',
				displayOptions: { show: { resource: ['scraper'], operation: ['run'] } },
			},
			{
				displayName: 'Options',
				name: 'runOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['scraper'], operation: ['run'] } },
				options: [
					{
						displayName: 'File Name',
						name: 'fileName',
						type: 'string',
						default: '',
						description: 'Custom name for the result file',
					},
					{
						displayName: 'Max Wait Time (Seconds)',
						name: 'maxWait',
						type: 'number',
						typeOptions: { minValue: 10 },
						default: 300,
						description: 'Give up waiting after this many seconds',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollInterval',
						type: 'number',
						typeOptions: { minValue: 2 },
						default: 5,
						description: 'How often to check the task status',
					},
					{
						displayName: 'Split Into Items',
						name: 'split',
						type: 'boolean',
						default: true,
						description: 'Whether to output each record as a separate item',
					},
				],
			},
			{
				displayName: 'Task IDs',
				name: 'taskIds',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 330ae83bcff7479b9c97e586dbf93801',
				description: 'One task ID, or up to 200 separated by commas',
				displayOptions: { show: { resource: ['scraper'], operation: ['getStatus'] } },
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 330ae83bcff7479b9c97e586dbf93801',
				displayOptions: { show: { resource: ['scraper'], operation: ['getResult'] } },
			},
			{
				displayName: 'File Type',
				name: 'fileType',
				type: 'options',
				options: [
					{ name: 'CSV', value: 'csv' },
					{ name: 'JSON', value: 'json' },
					{ name: 'XLSX', value: 'xlsx' },
				],
				default: 'json',
				description: 'JSON is returned as items; CSV and XLSX are returned as a binary file',
				displayOptions: { show: { resource: ['scraper'], operation: ['getResult'] } },
			},
			{
				displayName: 'Split Into Items',
				name: 'split',
				type: 'boolean',
				default: true,
				description: 'Whether to output each record as a separate item',
				displayOptions: {
					show: { resource: ['scraper'], operation: ['getResult'], fileType: ['json'] },
				},
			},

			// ----------------------------------
			//         Web Unblocker
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['webUnblocker'] } },
				options: [
					{
						name: 'Scrape URL',
						value: 'scrape',
						description: 'Fetch any web page through Novada Web Unblocker',
						action: 'Scrape a URL',
					},
				],
				default: 'scrape',
			},
			{
				displayName: 'URL',
				name: 'targetUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com',
				description: 'The page to fetch',
				displayOptions: { show: { resource: ['webUnblocker'], operation: ['scrape'] } },
			},
			{
				displayName: 'Render JavaScript',
				name: 'jsRender',
				type: 'boolean',
				default: false,
				description: 'Whether to render the page in a real browser before returning it',
				displayOptions: { show: { resource: ['webUnblocker'], operation: ['scrape'] } },
			},
			{
				displayName: 'Response Format',
				name: 'responseFormat',
				type: 'options',
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'PNG Screenshot', value: 'png' },
				],
				default: 'html',
				displayOptions: { show: { resource: ['webUnblocker'], operation: ['scrape'] } },
			},
			{
				displayName: 'Options',
				name: 'unblockerOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['webUnblocker'], operation: ['scrape'] } },
				options: [
					{
						displayName: 'Block Resources',
						name: 'blockResources',
						type: 'string',
						default: '',
						placeholder: 'e.g. image',
						description: 'Resource types to skip while loading the page',
					},
					{
						displayName: 'Country',
						name: 'country',
						type: 'string',
						default: '',
						placeholder: 'e.g. us',
						description: 'Two-letter country code of the exit location',
					},
					{
						displayName: 'Follow Redirects',
						name: 'followRedirects',
						type: 'boolean',
						default: true,
						description: 'Whether to follow URL redirects',
					},
					{
						displayName: 'Wait (Ms)',
						name: 'waitMs',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'Extra milliseconds to wait after the page loads',
					},
					{
						displayName: 'Wait for Selector',
						name: 'waitSelector',
						type: 'string',
						default: '',
						placeholder: 'e.g. .product-list',
						description: 'Return only after this element appears on the page',
					},
				],
			},

			// ----------------------------------
			//         Account
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Balance',
						value: 'getBalance',
						description: 'Get the remaining Scraper API balance',
						action: 'Get balance',
					},
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Get daily Scraper API and Web Unblocker consumption',
						action: 'Get usage',
					},
				],
				default: 'getBalance',
			},
			{
				displayName: 'Start Time',
				name: 'startTime',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['account'], operation: ['getUsage'] } },
			},
			{
				displayName: 'End Time',
				name: 'endTime',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['account'], operation: ['getUsage'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'scraper' && operation === 'run') {
					returnData.push(...(await runScraper.call(this, i)));
				} else if (resource === 'scraper' && operation === 'getStatus') {
					const taskIds = this.getNodeParameter('taskIds', i) as string;
					const body = await novadaRequest.call(
						this,
						i,
						MANAGEMENT_BASE_URL,
						'/v1/scraper/task_status',
						{ task_ids: taskIds.replace(/\s/g, '') },
						undefined,
						READ_ATTEMPTS,
					);
					returnData.push(...toItems((body.data as IDataObject)?.list, i, true));
				} else if (resource === 'scraper' && operation === 'getResult') {
					const taskId = (this.getNodeParameter('taskId', i) as string).trim();
					const fileType = this.getNodeParameter('fileType', i) as string;
					if (fileType === 'json') {
						const split = this.getNodeParameter('split', i) as boolean;
						returnData.push(...toItems(await downloadJson.call(this, i, taskId), i, split));
					} else {
						returnData.push(await downloadFile.call(this, i, taskId, fileType));
					}
				} else if (resource === 'webUnblocker' && operation === 'scrape') {
					returnData.push(await scrapeUrl.call(this, i));
				} else if (resource === 'account' && operation === 'getBalance') {
					const body = await novadaRequest.call(
						this,
						i,
						MANAGEMENT_BASE_URL,
						'/v1/capture/get_balance',
						{},
						undefined,
						READ_ATTEMPTS,
					);
					returnData.push(...toItems(body.data, i, false));
				} else if (resource === 'account' && operation === 'getUsage') {
					const body = await novadaRequest.call(
						this,
						i,
						MANAGEMENT_BASE_URL,
						'/v1/capture/logs',
						{},
						{
							start_time: toNovadaDate(this.getNodeParameter('startTime', i) as string),
							end_time: toNovadaDate(this.getNodeParameter('endTime', i) as string),
						},
						READ_ATTEMPTS,
					);
					returnData.push(...toItems((body.data as IDataObject)?.list, i, true));
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported operation "${operation}" for resource "${resource}"`,
						{ itemIndex: i },
					);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Keeps message and description of NodeApiError / NodeOperationError thrown above
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

async function runScraper(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const parameterStyle = this.getNodeParameter('parameterStyle', i) as string;
	const waitForResult = this.getNodeParameter('waitForResult', i) as boolean;
	const options = this.getNodeParameter('runOptions', i, {}) as IDataObject;
	const split = (options.split as boolean | undefined) ?? true;

	const form: IDataObject = {
		scraper_name: (this.getNodeParameter('scraperName', i) as string).trim(),
		scraper_id: (this.getNodeParameter('scraperId', i) as string).trim(),
		scraper_errors: 'true',
		file_name: options.fileName,
	};

	if (parameterStyle === 'flat') {
		const fields = parseJsonParameter.call(
			this,
			this.getNodeParameter('flatParams', i),
			'Search Fields',
			i,
		);
		if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
			throw new NodeOperationError(this.getNode(), '"Search Fields" must be a JSON object', {
				itemIndex: i,
			});
		}
		Object.assign(form, fields);
	} else {
		const params = parseJsonParameter.call(
			this,
			this.getNodeParameter('scraperParams', i),
			'Scraper Params',
			i,
		);
		form.scraper_params = JSON.stringify(Array.isArray(params) ? params : [params]);
	}

	const created = await novadaRequest.call(this, i, SCRAPER_BASE_URL, '/request', form);
	const payload = created.data as IDataObject | undefined;
	const taskId = (payload?.data as IDataObject | undefined)?.task_id as string | undefined;

	// Synchronous scenarios (SERP, AI platforms) return the data directly
	if (!taskId) return toItems(payload?.data ?? payload, i, split);

	if (!waitForResult)
		return [{ json: { task_id: taskId, status: 'Running' }, pairedItem: { item: i } }];

	const pollMs = ((options.pollInterval as number | undefined) ?? 5) * 1000;
	const deadline = Date.now() + ((options.maxWait as number | undefined) ?? 300) * 1000;

	while (Date.now() < deadline) {
		await sleep(pollMs);
		const statusBody = await novadaRequest.call(
			this,
			i,
			MANAGEMENT_BASE_URL,
			'/v1/scraper/task_status',
			{
				task_ids: taskId,
			},
			undefined,
			READ_ATTEMPTS,
		);
		const list = ((statusBody.data as IDataObject)?.list ?? []) as IDataObject[];
		const status = list[0]?.status as string | undefined;

		if (status === 'Ready') return toItems(await downloadJson.call(this, i, taskId), i, split);
		if (status === 'Failed' || status === 'Invalid task ID') {
			throw new NodeOperationError(
				this.getNode(),
				`Novada task ${taskId} ended with status "${status}"`,
				{
					itemIndex: i,
				},
			);
		}
	}

	throw new NodeOperationError(this.getNode(), `Novada task ${taskId} did not finish in time`, {
		itemIndex: i,
		description:
			'Increase "Max Wait Time", or turn off "Wait for Result" and use "Get Task Result" later.',
	});
}

async function getDownloadUrl(
	this: IExecuteFunctions,
	i: number,
	taskId: string,
	fileType: string,
) {
	const body = await novadaRequest.call(
		this,
		i,
		MANAGEMENT_BASE_URL,
		'/v1/scraper/task_download',
		{ task_ids: taskId, file_type: fileType },
		undefined,
		READ_ATTEMPTS,
	);
	const url = ((body.data as IDataObject[] | undefined)?.[0]?.download ?? '') as string;
	if (!url) {
		throw new NodeOperationError(this.getNode(), `No result file is available for task ${taskId}`, {
			itemIndex: i,
			description: 'Check the task status first. Only tasks with status "Ready" have results.',
		});
	}
	if (!/^https?:\/\//i.test(url)) {
		throw new NodeOperationError(
			this.getNode(),
			`Novada returned an invalid download link for task ${taskId}`,
			{
				itemIndex: i,
				description: `For search scrapers such as google_search, add "json": "1" to Search Fields so results are stored as JSON. Response from task_download: ${JSON.stringify(body).slice(0, 1000)}`,
			},
		);
	}
	return url;
}

async function downloadJson(this: IExecuteFunctions, i: number, taskId: string): Promise<unknown> {
	const url = await getDownloadUrl.call(this, i, taskId, 'json');
	try {
		return parseBody(
			await withNetworkRetry(
				READ_ATTEMPTS,
				async () => await this.helpers.httpRequest({ method: 'GET', url, json: true }),
			),
		);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
	}
}

async function downloadFile(
	this: IExecuteFunctions,
	i: number,
	taskId: string,
	fileType: string,
): Promise<INodeExecutionData> {
	const url = await getDownloadUrl.call(this, i, taskId, fileType);
	let content: Buffer;
	try {
		content = (await withNetworkRetry(
			READ_ATTEMPTS,
			async () => await this.helpers.httpRequest({ method: 'GET', url, encoding: 'arraybuffer' }),
		)) as Buffer;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
	}
	return {
		json: { task_id: taskId, download: url },
		binary: {
			data: await this.helpers.prepareBinaryData(Buffer.from(content), `${taskId}.${fileType}`),
		},
		pairedItem: { item: i },
	};
}

async function scrapeUrl(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const targetUrl = (this.getNodeParameter('targetUrl', i) as string).trim();
	const jsRender = this.getNodeParameter('jsRender', i) as boolean;
	const responseFormat = this.getNodeParameter('responseFormat', i) as string;
	const options = this.getNodeParameter('unblockerOptions', i, {}) as IDataObject;

	const requestOptions: IHttpRequestOptions = {
		method: 'POST',
		url: `${UNBLOCKER_BASE_URL}/request`,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: toForm({
			target_url: targetUrl,
			response_format: responseFormat,
			js_render: jsRender ? 'True' : 'False',
			country: options.country,
			block_resources: options.blockResources,
			wait_ms: options.waitMs ? options.waitMs : undefined,
			wait_selector: options.waitSelector,
			follow_redirects:
				options.followRedirects === undefined
					? undefined
					: options.followRedirects
						? 'True'
						: 'False',
		}),
		encoding: 'arraybuffer',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};

	let response: { body: Buffer; headers: IDataObject };
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'novadaApi',
			requestOptions,
		)) as { body: Buffer; headers: IDataObject };
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
	}

	const content = Buffer.from(response.body);
	const contentType = String(response.headers['content-type'] ?? '');

	if (contentType.includes('image/')) {
		return {
			json: { url: targetUrl },
			binary: {
				data: await this.helpers.prepareBinaryData(content, 'screenshot.png', 'image/png'),
			},
			pairedItem: { item: i },
		};
	}

	const parsed = parseBody(content.toString('utf8'));
	assertSuccess.call(this, parsed, i);
	if (typeof parsed === 'string')
		return { json: { url: targetUrl, html: parsed }, pairedItem: { item: i } };
	return { json: { url: targetUrl, ...(parsed as IDataObject) }, pairedItem: { item: i } };
}
