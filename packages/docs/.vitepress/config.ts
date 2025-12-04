import { defineConfig } from "vitepress"

export default defineConfig({
	// Defines where your docs live. If hosting on https://site.com/ice/, this should be "/ice/"
	base: "/ice/",
	title: "Ice.ts Task Runner",
	description: "TypeScript Task Runner for the Internet Computer",

	// Clean URLs (remove .html extensions)
	cleanUrls: true,
    srcExclude: ["**/content/**"],

	themeConfig: {
		// Top-level Navigation
		nav: [
			{ text: "Guide", link: "/guide/quick-start" },
			{ text: "API", link: "/reference/" },
		],

		// The Sidebar - explicitly mapping Concepts to Files
		sidebar: {
			// Guide & Concepts sidebar
			"/guide/": [
				{
					text: "Introduction",
					items: [
						{ text: "Quick Start", link: "/guide/quick-start" },
						{ text: "Why Ice?", link: "/guide/why-ice" },
					],
				},
				{
					text: "Core Concepts",
					items: [
						{ text: "Tasks", link: "/core-concepts/tasks" },
						{ text: "Canisters", link: "/core-concepts/canisters" },
						{
							text: "Configuration",
							link: "/core-concepts/configuration",
						},
						{
							text: "Environment",
							link: "/core-concepts/environment",
						},
					],
				},
				{
					text: "Recipes",
					items: [
						{
							text: "Common Workflows",
							link: "/recipes/common-workflows",
						},
						{ text: "Identities", link: "/recipes/identities" },
						{
							text: "Prebuilt Canisters",
							link: "/recipes/prebuilt-canisters",
						},
						{
							text: "Common Errors",
							link: "/recipes/common-errors",
						},
						{ text: "FAQ", link: "/recipes/faq" },
					],
				},
				{
					text: "Ecosystem",
					items: [
						{
							text: "@ice/canisters",
							link: "/guide/ice-canisters",
						},
						{
							text: "VSCode Extension",
							link: "/guide/vscode-extension",
						},
					],
				},
			],

			// Core Concepts pages should show the same sidebar
			"/core-concepts/": [
				{
					text: "Introduction",
					items: [
						{ text: "Quick Start", link: "/guide/quick-start" },
						{ text: "Why Ice?", link: "/guide/why-ice" },
					],
				},
				{
					text: "Core Concepts",
					items: [
						{ text: "Tasks", link: "/core-concepts/tasks" },
						{ text: "Canisters", link: "/core-concepts/canisters" },
						{
							text: "Configuration",
							link: "/core-concepts/configuration",
						},
						{
							text: "Environment",
							link: "/core-concepts/environment",
						},
					],
				},
				{
					text: "Recipes",
					items: [
						{
							text: "Common Workflows",
							link: "/recipes/common-workflows",
						},
						{ text: "Identities", link: "/recipes/identities" },
						{
							text: "Prebuilt Canisters",
							link: "/recipes/prebuilt-canisters",
						},
						{
							text: "Common Errors",
							link: "/recipes/common-errors",
						},
						{ text: "FAQ", link: "/recipes/faq" },
					],
				},
				{
					text: "Ecosystem",
					items: [
						{
							text: "@ice/canisters",
							link: "/guide/ice-canisters",
						},
						{
							text: "VSCode Extension",
							link: "/guide/vscode-extension",
						},
					],
				},
			],

			// Recipes pages should show the same sidebar
			"/recipes/": [
				{
					text: "Introduction",
					items: [
						{ text: "Quick Start", link: "/guide/quick-start" },
						{ text: "Why Ice?", link: "/guide/why-ice" },
					],
				},
				{
					text: "Core Concepts",
					items: [
						{ text: "Tasks", link: "/core-concepts/tasks" },
						{ text: "Canisters", link: "/core-concepts/canisters" },
						{
							text: "Configuration",
							link: "/core-concepts/configuration",
						},
						{
							text: "Environment",
							link: "/core-concepts/environment",
						},
					],
				},
				{
					text: "Recipes",
					items: [
						{
							text: "Common Workflows",
							link: "/recipes/common-workflows",
						},
						{ text: "Identities", link: "/recipes/identities" },
						{
							text: "Prebuilt Canisters",
							link: "/recipes/prebuilt-canisters",
						},
						{
							text: "Common Errors",
							link: "/recipes/common-errors",
						},
						{ text: "FAQ", link: "/recipes/faq" },
					],
				},
				{
					text: "Ecosystem",
					items: [
						{
							text: "@ice/canisters",
							link: "/guide/ice-canisters",
						},
						{
							text: "VSCode Extension",
							link: "/guide/vscode-extension",
						},
					],
				},
			],

			// API Reference (Mapped to TypeDoc Output)
			"/reference/": [
				{
					text: "Essentials",
					collapsed: false,
					items: [
						{ text: "Overview", link: "/reference/" },
						{
							text: "Task",
							collapsed: true,
							items: [
								{
									text: "task()",
									link: "/reference/functions/task",
								},
								{
									text: "Task (Type)",
									link: "/reference/type-aliases/Task",
								},
								{
									text: "TaskBuilder",
									link: "/reference/interfaces/TaskBuilder",
								},
								{
									text: "TaskCtx",
									link: "/reference/interfaces/TaskCtx",
								},
								{
									text: "TaskParam",
									link: "/reference/interfaces/TaskParam",
								},
								{
									text: "NamedParam",
									link: "/reference/interfaces/NamedParam",
								},
								{
									text: "PositionalParam",
									link: "/reference/interfaces/PositionalParam",
								},
							],
						},
						{
							text: "Scope",
							collapsed: true,
							items: [
								{
									text: "scope()",
									link: "/reference/functions/scope",
								},
								{
									text: "Scope (Type)",
									link: "/reference/type-aliases/Scope",
								},
							],
						},
						{
							text: "Ice",
							collapsed: true,
							items: [
								{
									text: "Ice()",
									link: "/reference/functions/Ice",
								},
								{
									text: "ICEConfig",
									link: "/reference/type-aliases/ICEConfig",
								},
								{
									text: "IceConfigLoader",
									link: "/reference/type-aliases/IceConfigLoader",
								},
							],
						},
						{
							text: "canister",
							link: "/reference/variables/canister",
						},
					],
				},
				{
					text: "Canister Definitions",
					collapsed: false,
					items: [
						{
							text: "Motoko",
							collapsed: true,
							items: [
								{
									text: "MotokoCanisterBuilder",
									link: "/reference/interfaces/MotokoCanisterBuilder",
								},
								{
									text: "MotokoCanisterConfig",
									link: "/reference/interfaces/MotokoCanisterConfig",
								},
								{
									text: "MotokoCanisterScope",
									link: "/reference/interfaces/MotokoCanisterScope",
								},
							],
						},
						{
							text: "Rust",
							collapsed: true,
							items: [
								{
									text: "RustCanisterBuilder",
									link: "/reference/interfaces/RustCanisterBuilder",
								},
								{
									text: "RustCanisterConfig",
									link: "/reference/interfaces/RustCanisterConfig",
								},
								{
									text: "RustCanisterScope",
									link: "/reference/interfaces/RustCanisterScope",
								},
							],
						},
						{
							text: "Custom",
							collapsed: true,
							items: [
								{
									text: "CustomCanisterBuilder",
									link: "/reference/interfaces/CustomCanisterBuilder",
								},
								{
									text: "CustomCanisterConfig",
									link: "/reference/interfaces/CustomCanisterConfig",
								},
								{
									text: "CustomCanisterScope",
									link: "/reference/interfaces/CustomCanisterScope",
								},
							],
						},
						{
							text: "Remote",
							collapsed: true,
							items: [
								{
									text: "RemoteCanisterBuilder",
									link: "/reference/interfaces/RemoteCanisterBuilder",
								},
								{
									text: "RemoteCanisterConfig",
									link: "/reference/interfaces/RemoteCanisterConfig",
								},
								{
									text: "RemoteCanisterScope",
									link: "/reference/interfaces/RemoteCanisterScope",
								},
							],
						},
						{
							text: "CanisterSettings",
							link: "/reference/interfaces/CanisterSettings",
						},
					],
				},
				{
					text: "Config & Environment",
					collapsed: false,
					items: [
						{
							text: "Replica",
							collapsed: true,
							items: [
								{
									text: "Replica (Type)",
									link: "/reference/type-aliases/Replica",
								},
								{
									text: "ICReplica",
									link: "/reference/classes/ICReplica",
								},
								{
									text: "PICReplica",
									link: "/reference/classes/PICReplica",
								},
							],
						},
						{
							text: "Identity",
							collapsed: true,
							items: [
								{
									text: "Ids",
									link: "/reference/variables/Ids",
								},
								{
									text: "ICEUser",
									link: "/reference/type-aliases/ICEUser",
								},
							],
						},
						{
							text: "TaskCtxExtension",
							link: "/reference/interfaces/TaskCtxExtension",
						},
						{
							text: "TaskTreeNode",
							link: "/reference/type-aliases/TaskTreeNode",
						},
					],
				},
			],
		},

		socialLinks: [
			{ icon: "github", link: "https://github.com/MioQuispe/ice.ts" },
		],

		// Better search experience
		search: {
			provider: "local",
		},
	},
})
