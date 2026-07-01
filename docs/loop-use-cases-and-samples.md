# Agent Loops in Practice — Use Cases & Best Samples

## 1. Catalog of Real-World Loop Use Cases

### 1.1 Code Quality and Engineering Health
*   **ship-PR-until-green**: **What**: Continuously adjusts pull request code in response to failing CI tests. | **Why**: Ensures code satisfies all pipeline requirements before human review. | **Stop Condition**: Passing CI/CD pipeline status.
*   **test-until-pass**: **What**: Iterates through code implementation based on failing unit tests defining feature behavior. | **Why**: Automates Test-Driven Development (TDD) and ensures functional correctness. | **Stop Condition**: All unit tests return a success status.
*   **coverage-until-threshold**: **What**: Targets uncovered branches by writing additional unit tests recursively. | **Why**: Systematically expands the test suite to meet organizational safety standards. | **Stop Condition**: Codebase reaches the specified coverage percentage.
*   **flaky-stabilize**: **What**: Repeatedly executes and refines tests that demonstrate non-deterministic failure patterns. | **Why**: Reduces engineering noise and improves CI reliability. | **Stop Condition**: Targeted tests pass consistently over $N$ consecutive runs.
*   **dead-code-sweep**: **What**: Scans the repository for unused functions, variables, and imports and removes them. | **Why**: Reduces technical debt and minimizes context window dilution for future agent tasks. | **Stop Condition**: Linter and static analysis confirm zero orphaned symbols.
*   **perf-budget-check**: **What**: Adjusts implementation details (e.g., batching network queries or optimizing I/O) based on performance benchmarks. | **Why**: Prevents performance regressions common in AI-authored code. | **Stop Condition**: Performance metrics fall within defined budget limits.

### 1.2 Security and Compliance
*   **CVE-burndown (Automated Vulnerability Repair)**: **What**: Generates patches for known vulnerabilities and verifies them against Proof-of-Concept (PoC) exploit scripts. | **Why**: Accelerates security patching in reproducible container environments. | **Stop Condition**: PoC exploit is blocked while the standard test suite remains green.
*   **security-hardening**: **What**: Replaces outdated security patterns and insecure object references with modern, secure alternatives. | **Why**: Mitigates the higher rate of security vulnerabilities found in raw AI contributions. | **Stop Condition**: Security scanner returns zero critical/major findings.
*   **a11y-until-clean (Accessibility Loop)**: **What**: Audits frontend components using accessibility engines and fixes violations. | **Why**: Ensures digital accessibility standards (e.g., WCAG 2.1) are programmatically enforced. | **Stop Condition**: Audit report (e.g., axe-core) returns zero violations.

### 1.3 Operations and Maintenance
*   **breaking-change-migration (Fan-out-and-Synthesize)**: **What**: Orchestrates a large migration by splitting tasks across isolated modules in separate worktrees. | **Why**: Handles complex, multi-file refactors that exceed single-context window limits. | **Stop Condition**: Orchestrator successfully merges and verifies all sub-modules.
*   **docs-sync**: **What**: Audits documentation against source code changes and updates outdated explanations. | **Why**: Maintains alignment between technical specifications and implementation state. | **Stop Condition**: Documentation consistency checker validates synchronization.
*   **green-keeper (Dependency updates)**: **What**: Automatically updates project dependencies and resolves resulting build or test breaks. | **Why**: Prevents dependency rot and ensures early detection of breaking upstream changes. | **Stop Condition**: Successful build and test pass on the updated dependency tree.
*   **error-sweep**: **What**: Monitors logs for unhandled exceptions and implements missing guard statements or null checks. | **Why**: Resolves error-handling gaps common in autonomous code generation. | **Stop Condition**: Targeted exception paths are verified as handled in the test environment.

## 2. Gate Mechanics: The "Maker != Checker" Pattern

Autonomous agent loops are highly susceptible to **self-preferential bias**, a failure mode where an agent incorrectly validates its own work. Because the agent inherits the same context, assumptions, and potential hallucinations used to generate the code, it often creates "blind spots" during verification. This necessitates the "Maker != Checker" pattern, which enforces the structural separation of generation and verification.

### 2.1 The Maturity Ladder and Independent Verifier Architecture

To manage risk, we utilize a **Maturity Model** to transition code generation tasks from manual intervention to autonomous merging:

| Maturity Level | Designation | Operational Profile |
| :--- | :--- | :--- |
| **Level 0** | Manual | Developer prompts the agent turn-by-turn in an active session. |
| **Level 1** | Triage | Scheduled loops scan repositories and write findings to read-only reports. |
| **Level 2** | Draft | Agent writes mutations to an isolated branch; relies on human review to merge. |
| **Level 3** | Verified PR | Mutations are analyzed by an independent verification agent before reaching a human. |
| **Level 4** | Auto-Merge | Agent identifies, executes, gates, and merges work autonomously with rollback systems. |

To eliminate bias at higher maturity levels, modern architectures utilize an **Independent Verifier** where code generation is decoupled from the verification logic.

*   **ACToR (Adversarial C To Rust) Loop**: This architectural case study utilizes a generator-translator agent alongside an independent discriminator agent. The discriminator acts as an adversary by running a **differential fuzzer**. This fuzzer sends identical random inputs to both the original C and the new Rust binaries. If outputs diverge, the discriminator captures the failing input as a counterexample, forcing the translator to refine its work until semantic equivalence is achieved.
*   **Skeptic Agent Pattern**: Primarily used in web testing to combat **"pump-and-pass" tests** (tests that render a component but lack deep behavioral assertions). The skeptic agent operates in an isolated context and reviews generated tests against a strict rubric, checking for DOM element movement and error state verification to ensure the tests prove actual functionality.

### 2.2 Types of Deterministic Gates

| Gate Type | Operational Logic | Verification Method (Shell/AI) |
| :--- | :--- | :--- |
| **Quality Gates** | Executes unit tests, linters, and type-checks after every iteration. | **Shell** (Deterministic output) |
| **Periodic Code Review** | A read-only AI session analyzes git diffs for architectural breaks or logic flaws. | **AI** (Diagnostic context) |
| **Visual Browser Verification** | Captures animated GIFs of user flows (e.g., via Playwright) to provide visual proof. | **Shell/AI** (Artifact generation) |
| **Write Heartbeat** | Kills the driver if the agent is stuck in a "read" state without mutations for $N$ minutes. | **Shell** (Process monitoring) |

## 3. The Auto-Prompt & Context Re-Arming Mechanism

Practitioners must manage state over long-running loops (hours or days) without saturating the context window, which leads to cognitive drift and excessive costs.

### 3.1 Context Re-Arming vs. Conversational History
Traditional agents rely on a **bloated conversation history**, where every turn adds to a single context window. **Context re-arming** rejects this. Instead, each cycle initializes a completely fresh model session. This prevents "context rot" and ensures the agent remains focused on the current state of the filesystem rather than its previous chat turns.

### 3.2 State-on-Disk Structures
Context re-arming treats the local disk as the cumulative memory of the agent, using three primary structures:
*   **The Progress Journal (`progress.txt`)**: An append-only log where the agent documents attempts, pitfalls, and successful design patterns for the next iteration to read.
*   **The Structured Backlog (`prd.json`)**: A requirement tracker using boolean variables (e.g., `passes: true`) to ensure work can resume safely after timeouts or crashes.
*   **Git Repository History**: Local diffs against the main branch serve as the objective representation of the codebase's evolution.

### 3.3 Scheduling and Invocation Primitives
Agent loops are controlled using specific primitives within CLI environments like Claude Code:
*   **/goal**: An inline, turn-by-turn verification loop for immediate code fixes.
*   **/loop**: Standard background scheduling (e.g., cron) for periodic environmental audits.
*   **/batch**: Parallel execution across separate local git worktrees for large-scale refactors.

The **Ralph (Ralph Wiggum) Loop**, a term coined by **Geoffrey Huntley in July 2025**, represents persistent iteration despite setbacks. Its technical execution involves using exit hooks to intercept **exit code 2**. When the agent attempts to finish, a shell script suppresses the termination and reinjects the task prompt along with updated validation results until the deterministic gate is satisfied.

## 4. The "Top 6" Starter Loops for Engineers

1.  **ship-PR-until-green (The CI Stabilizer)**: This loop targets the "last mile" of development. By hooking into CI pipelines, it ensures that an agent repeatedly fixes minor linting, dependency, or environmental errors until the build is green, saving developers from the manual "commit-push-fail" cycle.
2.  **test-until-pass (The TDD Automation)**: Leveraging the **Superpowers plugin**, this loop follows a strict TDD flow: writing failing tests first, then iterating on the implementation until functional correctness is verified by the test suite.
3.  **a11y-until-clean (The Accessibility Compliance Guard)**: Utilizing **Playwright**, **axe-core**, and the **Model Context Protocol (MCP)**, this loop identifies and repairs DOM-level accessibility violations (WCAG 2.1). It automates audits that are traditionally difficult for humans to perform comprehensively.
4.  **CVE-burndown (The Automated Security Patcher)**: This loop uses **Docker containers** and **PoC exploit scripts** to generate and verify security patches. The gate only clears when the patch successfully blocks the exploit while keeping the standard test suite green.
5.  **Coverage-until-threshold (The Test Suite Expander)**: This loop identifies gaps in a coverage matrix and assigns worker agents to write targeted unit tests. It is the most effective way to improve legacy codebase health without dedicated human sprint time.
6.  **Fan-out Migration (The Refactoring Orchestrator)**: Using the **`bdh` CLI** and **`beads` integration**, this loop splits large migrations into isolated git worktrees. Parallel agents refactor independent components before the orchestrator synthesizes them into a single, verified PR.

## 5. Strategic Safety, Stop Conditions, and Anti-Patterns

### 5.1 Deterministic Stop Boundaries
To prevent financial waste and "runaway" loops, three mandatory limits must be established:
*   **Iteration Ceilings**: A hard cap on the total number of cycles.
*   **Financial/Token Budgets**: Real-time monitoring of API spend (e.g., halting at $5.00).
*   **Stagnation Monitoring**: This is mathematically defined by a progress threshold $\epsilon$ across a sliding window $k$: 
    $$\sum_{i=0}^{k-1} \|\mathbf{M}_{t-i} - \mathbf{M}_{t-i-1}\|_2 < \epsilon$$
    where $\mathbf{M}_t$ is a metric vector of codebase state (coverage, syntax validity, etc.).

**Cycle Detection** prevents agents from alternating between two incorrect states. The system tracks the state footprint $S_t = (\mathcal{F}_t, \mathcal{E}_t)$ where $\mathcal{F}$ is the set of modified files and $\mathcal{E}$ is the error message. If $S_t = S_{t-\tau}$ (matching a previous state), the loop is terminated.

### 5.2 Critical Anti-Patterns to Avoid
1.  **Self-Grading (The Conflict of Interest)**: Allowing the agent that wrote the code to verify it, leading to "logical green runs" where tests are gamed.
2.  **No Stop Condition (The Infinite Token Spend)**: Running loops without circuit breakers or financial caps.
3.  **Gameable Gates**: Using gates the agent can bypass, such as commenting out failing tests or deleting linting rules.
4.  **No Iteration Cap**: Failing to set a maximum cycle count, allowing agents to get stuck in local minima.
5.  **Agentic Laziness**: Claiming a task is complete when code writing has stopped (mitigated by the **Write Heartbeat**, which kills the driver if the AI is stuck reading without writing).

## 6. Conclusion: The Shifting Bottleneck

As engineering workflows move toward autonomous execution, the primary bottleneck shifts from **Engineering Execution** to **Product Taste**. In a landmark case study, a Ralph loop shipped **102 verified features** in a single week for a backcountry app, moving beyond specifications to design complex physics-based avalanche simulations and foraging models. 

When execution is commoditized, the challenge becomes "what to build." This transition relies on the **Opportunity Finder (AI PM)**, which grounds autonomous loops in real-world analytics, session replays, and customer feedback. By automating the "how," loop engineering allows the architect to focus entirely on the value and impact of the "what."