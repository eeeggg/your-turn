import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { getOutputChannel, outputChannelSink } from '@/adapters/OutputChannels';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('formulahendry.acp-client'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Routes levelled diagnostics through VS Code LogOutputChannel methods', () => {
		const channel = getOutputChannel();
		assert.strictEqual(typeof channel.trace, 'function');
		assert.strictEqual(typeof channel.debug, 'function');
		assert.strictEqual(typeof channel.info, 'function');
		assert.strictEqual(typeof channel.warn, 'function');
		assert.strictEqual(typeof channel.error, 'function');
		assert.strictEqual(typeof channel.logLevel, 'number');
		outputChannelSink.info('Integration check for LogOutputChannel adapter');
	});

	test('Registers exactly the commands it contributes, and its menus and keybindings name only those', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		await ext.activate();
		const { commands, menus, keybindings = [] } = (ext.packageJSON as { contributes: {
			commands: { command: string }[];
			menus: Record<string, { command?: string }[]>;
			keybindings?: { command: string }[];
		} }).contributes;
		const contributed = commands.map(({ command }) => command);
		const registered = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('acp.'));
		assert.deepStrictEqual([...registered].sort(), [...contributed].sort());
		const named = [...Object.values(menus).flat().flatMap(({ command }) => command ?? []), ...keybindings.map(({ command }) => command)];
		assert.deepStrictEqual(named.filter((command) => command.startsWith('acp.') && !contributed.includes(command)), []);
	});

	test('Contributes no built-in agents', () => {
		assert.deepStrictEqual(vscode.workspace.getConfiguration('acp').inspect('agents')?.defaultValue, {});
	});

	// VS Code shows welcome content only in views that ask for it, such as tree views, never in a webview view like Chat.
	test('Offers adding and detecting agents in the empty Agents view, through registered commands', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		const { viewsWelcome } = (ext.packageJSON as { contributes: { viewsWelcome: { view: string; contents: string; when?: string }[] } }).contributes;
		assert.deepStrictEqual(viewsWelcome.map((welcome) => welcome.view), ['acp-sessions']);
		// VS Code shows a tree view's welcome until the tree's first items arrive, even when agents are configured.
		assert.deepStrictEqual(viewsWelcome.map((welcome) => welcome.when), ['acp.noAgentsConfigured']);
		const linked = viewsWelcome.flatMap((welcome) => [...welcome.contents.matchAll(/\(command:([\w.]+)\)/g)].flatMap((match) => match[1] ?? []));
		assert.deepStrictEqual(linked, ['acp.addAgent', 'acp.detectAgents']);
		const commands = await vscode.commands.getCommands(true);
		assert.deepStrictEqual(linked.filter((command) => !commands.includes(command)), []);
	});
});
