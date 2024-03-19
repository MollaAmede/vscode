/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ThemeIcon } from 'vs/base/common/themables';
import { URI } from 'vs/base/common/uri';
import { ProviderResult } from 'vs/editor/common/languages';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IRawChatCommandContribution, RawChatParticipantLocation } from 'vs/workbench/contrib/chat/common/chatContributionService';
import { IChatProgressResponseContent, IChatRequestVariableData } from 'vs/workbench/contrib/chat/common/chatModel';
import { IChatFollowup, IChatProgress, IChatResponseErrorDetails } from 'vs/workbench/contrib/chat/common/chatService';

//#region agent service, commands etc

export interface IChatAgentHistoryEntry {
	request: IChatAgentRequest;
	response: ReadonlyArray<IChatProgressResponseContent>;
	result: IChatAgentResult;
}

export enum ChatAgentLocation {
	Panel = 1,
	Terminal = 2,
	Notebook = 3,
	// Editor = 4
}

export namespace ChatAgentLocation {
	export function fromRaw(value: RawChatParticipantLocation | string): ChatAgentLocation {
		switch (value) {
			case 'panel': return ChatAgentLocation.Panel;
			case 'terminal': return ChatAgentLocation.Terminal;
			case 'notebook': return ChatAgentLocation.Notebook;
		}
		return ChatAgentLocation.Panel;
	}
}

// TODO reference this in IChatAgentData
export interface IChatAgentIdentifier {
	id: string;
	extensionId: ExtensionIdentifier;
}

export interface IChatAgentData {
	id: string;
	extensionId: ExtensionIdentifier;
	/** The agent invoked when no agent is specified */
	isDefault?: boolean;
	metadata: IChatAgentMetadata;
	slashCommands: IChatAgentCommand[];
	defaultImplicitVariables?: string[];
	locations: ChatAgentLocation[];
}

export interface IChatAgentImplementation {
	invoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult>;
	provideFollowups?(request: IChatAgentRequest, result: IChatAgentResult, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatFollowup[]>;
	provideWelcomeMessage?(token: CancellationToken): ProviderResult<(string | IMarkdownString)[] | undefined>;
	provideSampleQuestions?(token: CancellationToken): ProviderResult<IChatFollowup[] | undefined>;
}

export type IChatAgent = IChatAgentData & IChatAgentImplementation;

export interface IChatAgentCommand extends IRawChatCommandContribution {
	followupPlaceholder?: string;
}

export interface IChatRequesterInformation {
	name: string;

	/**
	 * A full URI for the icon of the requester.
	 */
	icon?: URI;
}

export interface IChatAgentMetadata {
	description?: string;
	helpTextPrefix?: string | IMarkdownString;
	helpTextVariablesPrefix?: string | IMarkdownString;
	helpTextPostfix?: string | IMarkdownString;
	isSecondary?: boolean; // Invoked by ctrl/cmd+enter
	fullName?: string;
	icon?: URI;
	iconDark?: URI;
	themeIcon?: ThemeIcon;
	sampleRequest?: string;
	supportIssueReporting?: boolean;
	followupPlaceholder?: string;
	isSticky?: boolean;
	requester?: IChatRequesterInformation;
}


export interface IChatAgentRequest {
	sessionId: string;
	requestId: string;
	agentId: string;
	command?: string;
	message: string;
	variables: IChatRequestVariableData;
	location: ChatAgentLocation;
}

export interface IChatAgentResult {
	errorDetails?: IChatResponseErrorDetails;
	timings?: {
		firstProgress?: number;
		totalElapsed: number;
	};
	/** Extra properties that the agent can use to identify a result */
	readonly metadata?: { readonly [key: string]: any };
}

export const IChatAgentService = createDecorator<IChatAgentService>('chatAgentService');

interface IChatAgentEntry {
	data: IChatAgentData;
	impl?: IChatAgentImplementation;
}

export interface IChatAgentService {
	_serviceBrand: undefined;
	/**
	 * undefined when an agent was removed IChatAgent
	 */
	readonly onDidChangeAgents: Event<IChatAgent | undefined>;
	registerAgent(id: IChatAgentIdentifier, data: IChatAgentData): IDisposable;
	registerAgentImplementation(id: IChatAgentIdentifier, agent: IChatAgentImplementation): IDisposable;
	registerDynamicAgent(data: IChatAgentData, agentImpl: IChatAgentImplementation): IDisposable;
	invokeAgent(agent: IChatAgentIdentifier, request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult>;
	getFollowups(id: IChatAgentIdentifier, request: IChatAgentRequest, result: IChatAgentResult, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatFollowup[]>;
	getAgent(id: IChatAgentIdentifier): IChatAgentData | undefined;
	getAgents(): IChatAgentData[];
	getActivatedAgents(): Array<IChatAgent>;
	getAgentsByName(name: string): IChatAgentData[];
	getDefaultAgent(): IChatAgent | undefined;
	getSecondaryAgent(): IChatAgentData | undefined;
	updateAgent(id: IChatAgentIdentifier, updateMetadata: IChatAgentMetadata): void;
}

export class ChatAgentService extends Disposable implements IChatAgentService {

	public static readonly AGENT_LEADER = '@';

	declare _serviceBrand: undefined;

	private _agents: IChatAgentEntry[] = [];

	private readonly _onDidChangeAgents = this._register(new Emitter<IChatAgent | undefined>());
	readonly onDidChangeAgents: Event<IChatAgent | undefined> = this._onDidChangeAgents.event;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService
	) {
		super();
	}

	registerAgent(id: IChatAgentIdentifier, data: IChatAgentData): IDisposable {
		const existingAgent = this.getAgent(id);
		if (existingAgent) {
			throw new Error(`Agent already registered: ${JSON.stringify(id)}`);
		}

		const that = this;
		const commands = data.slashCommands;
		data = {
			...data,
			get slashCommands() {
				return commands.filter(c => !c.when || that.contextKeyService.contextMatchesRules(ContextKeyExpr.deserialize(c.when)));
			}
		};
		const entry = { data };
		this._agents.push(entry);
		return toDisposable(() => {
			this._agents = this._agents.filter(a => a !== entry);
			this._onDidChangeAgents.fire(undefined);
		});
	}

	registerAgentImplementation(id: IChatAgentIdentifier, agentImpl: IChatAgentImplementation): IDisposable {
		const entry = this._getAgentEntry(id);
		if (!entry) {
			throw new Error(`Unknown agent: ${JSON.stringify(id)}`);
		}

		if (entry.impl) {
			throw new Error(`Agent already has implementation: ${JSON.stringify(id)}`);
		}

		entry.impl = agentImpl;
		this._onDidChangeAgents.fire(new MergedChatAgent(entry.data, agentImpl));

		return toDisposable(() => {
			this._agents = this._agents.filter(a => a !== entry);
			this._onDidChangeAgents.fire(undefined);
		});
	}

	registerDynamicAgent(data: IChatAgentData, agentImpl: IChatAgentImplementation): IDisposable {
		const agent = { data, impl: agentImpl };
		this._agents.push(agent);
		this._onDidChangeAgents.fire(new MergedChatAgent(data, agentImpl));

		return toDisposable(() => {
			this._agents = this._agents.filter(a => a !== agent);
			this._onDidChangeAgents.fire(undefined);
		});
	}

	updateAgent(id: IChatAgentIdentifier, updateMetadata: IChatAgentMetadata): void {
		const agent = this._getAgentEntry(id);
		if (!agent?.impl) {
			throw new Error(`No activated agent with id ${JSON.stringify(id)} registered`);
		}
		agent.data.metadata = { ...agent.data.metadata, ...updateMetadata };
		this._onDidChangeAgents.fire(new MergedChatAgent(agent.data, agent.impl));
	}

	getDefaultAgent(): IChatAgent | undefined {
		return this.getActivatedAgents().find(a => !!a.isDefault);
	}

	getSecondaryAgent(): IChatAgentData | undefined {
		// TODO also static
		return Iterable.find(this._agents.values(), a => !!a.data.metadata.isSecondary)?.data;
	}

	private _getAgentEntry(id: IChatAgentIdentifier): IChatAgentEntry | undefined {
		return this._agents.find(a => a.data.id === id.id && ExtensionIdentifier.equals(a.data.extensionId, id.extensionId));
	}

	getAgent(id: IChatAgentIdentifier): IChatAgentData | undefined {
		return this._getAgentEntry(id)?.data;
	}

	/**
	 * Returns all agent datas that exist- static registered and dynamic ones.
	 */
	getAgents(): IChatAgentData[] {
		return this._agents.map(entry => entry.data);
	}

	getActivatedAgents(): IChatAgent[] {
		return Array.from(this._agents.values())
			.filter(a => !!a.impl)
			.map(a => new MergedChatAgent(a.data, a.impl!));
	}

	getAgentsByName(name: string): IChatAgentData[] {
		return this.getAgents().filter(a => a.id === name);
	}

	async invokeAgent(id: IChatAgentIdentifier, request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const data = this._getAgentEntry(id);
		if (!data?.impl) {
			throw new Error(`No activated agent with id ${id}`);
		}

		return await data.impl.invoke(request, progress, history, token);
	}

	async getFollowups(id: IChatAgentIdentifier, request: IChatAgentRequest, result: IChatAgentResult, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatFollowup[]> {
		const data = this._getAgentEntry(id);
		if (!data?.impl) {
			throw new Error(`No activated agent with id ${id}`);
		}

		if (!data.impl?.provideFollowups) {
			return [];
		}

		return data.impl.provideFollowups(request, result, history, token);
	}
}

export class MergedChatAgent implements IChatAgent {
	constructor(
		private readonly data: IChatAgentData,
		private readonly impl: IChatAgentImplementation
	) { }

	get id(): string { return this.data.id; }
	get extensionId(): ExtensionIdentifier { return this.data.extensionId; }
	get isDefault(): boolean | undefined { return this.data.isDefault; }
	get metadata(): IChatAgentMetadata { return this.data.metadata; }
	get slashCommands(): IChatAgentCommand[] { return this.data.slashCommands; }
	get defaultImplicitVariables(): string[] | undefined { return this.data.defaultImplicitVariables; }
	get locations(): ChatAgentLocation[] { return this.data.locations; }

	async invoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		return this.impl.invoke(request, progress, history, token);
	}

	async provideFollowups(request: IChatAgentRequest, result: IChatAgentResult, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatFollowup[]> {
		if (this.impl.provideFollowups) {
			return this.impl.provideFollowups(request, result, history, token);
		}

		return [];
	}

	provideWelcomeMessage(token: CancellationToken): ProviderResult<(string | IMarkdownString)[] | undefined> {
		if (this.impl.provideWelcomeMessage) {
			return this.impl.provideWelcomeMessage(token);
		}

		return undefined;
	}

	provideSampleQuestions(token: CancellationToken): ProviderResult<IChatFollowup[] | undefined> {
		if (this.impl.provideSampleQuestions) {
			return this.impl.provideSampleQuestions(token);
		}

		return undefined;
	}
}
