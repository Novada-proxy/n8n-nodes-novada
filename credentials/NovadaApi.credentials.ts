import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class NovadaApi implements ICredentialType {
	name = 'novadaApi';

	displayName = 'Novada API';

	icon: Icon = {
		light: 'file:../nodes/Novada/novada.svg',
		dark: 'file:../nodes/Novada/novada.dark.svg',
	};

	documentationUrl =
		'https://developer.novada.com/novada/advanced-proxy-solutions/scraper-api/getting-started';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Your Novada API key. Copy it from API Playground in the Novada dashboard.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Novada answers HTTP 200 even for a bad key, so the body code decides
	test: ICredentialTestRequest = {
		request: {
			url: 'https://api-m.novada.com/v1/capture/get_balance',
			method: 'POST',
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'code',
					value: 401,
					message: 'Invalid API key',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'code',
					value: 10000,
					message: 'Invalid API key',
				},
			},
		],
	};
}
