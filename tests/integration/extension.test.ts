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
	test('Offers adding and detecting agents in the empty Agents view, or a way into a window where it is available, through registered commands', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		await ext.activate();
		const { viewsWelcome } = (ext.packageJSON as { contributes: { viewsWelcome: { view: string; contents: string; when?: string }[] } }).contributes;
		assert.deepStrictEqual([...new Set(viewsWelcome.map((welcome) => welcome.view))], ['acp-sessions']);
		const linked = (contents: string) => [...contents.matchAll(/\(command:([\w.]+)\)/g)].flatMap((match) => match[1] ?? []);
		// VS Code shows a tree view's welcome until the tree's first items arrive, even when agents are configured.
		assert.deepStrictEqual(viewsWelcome.map((welcome) => [welcome.when, linked(welcome.contents)]), [
			['acp.noAgentsConfigured', ['acp.addAgent', 'acp.detectAgents']],
			['acp.workspaceUnavailable == empty', ['workbench.action.files.openFolder']],
			['acp.workspaceUnavailable == untitled', ['workbench.action.saveWorkspaceAs']],
			['acp.workspaceUnavailable == virtual', ['workbench.action.files.openFolder']],
		]);
		const commands = await vscode.commands.getCommands(true);
		assert.deepStrictEqual(viewsWelcome.flatMap((welcome) => linked(welcome.contents)).filter((command) => !commands.includes(command)), []);
	});

	// The `when` clauses below test a context key activation sets, so until it does they show everything.
	test('Activates once the window has started, rather than only when something of its own is used', () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		assert.deepStrictEqual((ext.packageJSON as { activationEvents: string[] }).activationEvents, ['onStartupFinished']);
	});

	// A window where the extension is unavailable shows the Agents view's title and every editor's title.
	test('Hides the chat view, its commands in the palette, and its buttons in the titles a window where it is unavailable shows', () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		const { views, commands, menus } = (ext.packageJSON as { contributes: {
			views: Record<string, { id: string; when?: string }[]>;
			commands: { command: string }[];
			menus: Record<string, { command: string; when?: string }[]>;
		} }).contributes;
		const unavailable = '!acp.workspaceUnavailable';
		assert.deepStrictEqual(Object.values(views).flat().map(({ id, when }) => [id, when]), [['acp-sessions', undefined], ['acp-chat', unavailable]]);
		const palette = new Map((menus['commandPalette'] ?? []).map(({ command, when }) => [command, when]));
		assert.deepStrictEqual(commands.map(({ command }) => command).filter((command) => {
			const when = palette.get(command);
			return when !== 'false' && when !== unavailable && !when?.startsWith(`${unavailable} && `);
		}), []);
		const titles = [...(menus['view/title'] ?? []).filter(({ when }) => when?.includes('view == acp-sessions')), ...(menus['editor/title'] ?? [])];
		assert.deepStrictEqual(titles.filter(({ when }) => !when?.startsWith(`${unavailable} && `)).map(({ command }) => command), []);
	});
});
