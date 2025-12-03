# Why Ice?

Ice is **TypeScript-native tooling for the IC**. It brings a declarative, composable, and type-safe workflow to canister development, similar to the Hardhat experience on Ethereum.

Building on the Internet Computer is powerful, but standard tooling hits a ceiling as complexity grows.

### Brittle Scripting
Orchestration often relies on Bash scripts that lack semantic understanding of your code. You have no autocomplete for arguments, forcing you to manually look up Candid syntax. Errors are often caught only after a deployment command fails halfway through execution.

### Siloed Infrastructure
Projects function as isolated units. You cannot easily import another developer's infrastructure setup into your own project. This forces every developer to manually configure standard components like Ledgers or Internet Identity for every new repo.

### Setup Fatigue
Setting up a complex environment usually involves a checklist of manual steps: install binary X, set flag Y, check version Z. There is no standard "clone and run" experience.

## The ICE Paradigm

ICE shifts canister orchestration from imperative scripts to **declarative infrastructure**.

### Type-Safety as a Standard
When infrastructure is TypeScript, your tooling understands your intent. ICE generates definitions for your specific actors, so your deployment logic enjoys the same safety as your application code. If you change a canister interface, your tasks turn red in the editor.

### Self-Contained Environments
ICE provides a zero-dependency experience. You simply `git clone` and `npm install`. Everything stays local to the project.

### Infrastructure as Code
ICE makes infrastructure portable. You can package a complex multi-canister setup (like a DeFi protocol) and publish it to npm. Other developers can import that setup and enable it with a single line of code, effectively turning canisters into libraries.