import { FEEDBACK_CATEGORIES } from "@squirrelscan/utils/constants";

import type { Result } from "@/controllers/types";

import { OUTPUT_FORMATS } from "@/constants";
import { ok, err, commandError } from "@/controllers/types";
import { RULE_CATEGORY_VALUES } from "@/rules/categories";

const categoryValues = RULE_CATEGORY_VALUES.join(" ");
const formatValues = OUTPUT_FORMATS.join(" ");
const feedbackCategoryValues = FEEDBACK_CATEGORIES.join(" ");

export type Shell = "bash" | "zsh" | "fish";

/**
 * Generate shell completion script for the specified shell
 */
export function generateCompletion(shell: Shell): Result<string> {
  switch (shell) {
    case "bash":
      return ok(generateBashCompletion());
    case "zsh":
      return ok(generateZshCompletion());
    case "fish":
      return ok(generateFishCompletion());
    default:
      return err(commandError("INVALID_SHELL", `Unknown shell: ${shell}`));
  }
}

function generateBashCompletion(): string {
  return `# squirrel bash completion
# Add to ~/.bashrc: eval "$(squirrel self completion bash)"

_squirrel_completions() {
  local cur prev words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # Global options
  local global_opts="--config-file -c"

  # Top-level commands
  local commands="audit auth crawl credits analyze init config report feedback keys mcp self skills"

  # Auth subcommands
  local auth_commands="login logout status whoami"

  # Keys subcommands
  local keys_commands="create list revoke"

  # Self subcommands
  local self_commands="install update completion doctor version settings uninstall"

  # Config subcommands
  local config_commands="show set path validate"

  # Settings subcommands
  local settings_commands="show set"

  # Settings keys
  local settings_keys="channel auto_update update_check_interval_hours notifications telemetry tips"

  case "\${COMP_WORDS[1]}" in
    self)
      case "\${prev}" in
        self)
          COMPREPLY=( $(compgen -W "\${self_commands}" -- "\${cur}") )
          return 0
          ;;
        settings)
          COMPREPLY=( $(compgen -W "\${settings_commands}" -- "\${cur}") )
          return 0
          ;;
        completion)
          COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
          return 0
          ;;
        update)
          COMPREPLY=( $(compgen -W "--check --dismiss --force" -- "\${cur}") )
          return 0
          ;;
        version)
          COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
          return 0
          ;;
        uninstall)
          COMPREPLY=( $(compgen -W "--purge --force" -- "\${cur}") )
          return 0
          ;;
        install)
          COMPREPLY=( $(compgen -W "--bin-dir" -- "\${cur}") )
          return 0
          ;;
      esac
      # Handle settings set <key> completions
      if [[ "\${COMP_WORDS[2]}" == "settings" && "\${COMP_WORDS[3]}" == "set" ]]; then
        if [[ "\${COMP_CWORD}" == 4 ]]; then
          COMPREPLY=( $(compgen -W "\${settings_keys}" -- "\${cur}") )
          return 0
        elif [[ "\${COMP_CWORD}" == 5 && "\${COMP_WORDS[4]}" == "channel" ]]; then
          COMPREPLY=( $(compgen -W "stable beta" -- "\${cur}") )
          return 0
        elif [[ "\${COMP_CWORD}" == 5 ]]; then
          COMPREPLY=( $(compgen -W "true false" -- "\${cur}") )
          return 0
        elif [[ "\${cur}" == -* ]]; then
          COMPREPLY=( $(compgen -W "--local --user" -- "\${cur}") )
          return 0
        fi
      fi
      # Handle settings show options
      if [[ "\${COMP_WORDS[2]}" == "settings" && "\${COMP_WORDS[3]}" == "show" && "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "--local --user" -- "\${cur}") )
        return 0
      fi
      ;;
    config)
      case "\${prev}" in
        config)
          COMPREPLY=( $(compgen -W "\${config_commands}" -- "\${cur}") )
          return 0
          ;;
      esac
      ;;
    skills)
      case "\${prev}" in
        skills)
          COMPREPLY=( $(compgen -W "install update" -- "\${cur}") )
          return 0
          ;;
      esac
      ;;
    auth)
      case "\${prev}" in
        auth)
          COMPREPLY=( $(compgen -W "\${auth_commands}" -- "\${cur}") )
          return 0
          ;;
        login)
          COMPREPLY=( $(compgen -W "--device-name -d" -- "\${cur}") )
          return 0
          ;;
        status|whoami)
          COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
          return 0
          ;;
      esac
      ;;
    keys)
      case "\${prev}" in
        keys)
          COMPREPLY=( $(compgen -W "\${keys_commands}" -- "\${cur}") )
          return 0
          ;;
        create)
          COMPREPLY=( $(compgen -W "--name --scopes --expires-days --shell --json" -- "\${cur}") )
          return 0
          ;;
        list)
          COMPREPLY=( $(compgen -W "--json" -- "\${cur}") )
          return 0
          ;;
        revoke)
          COMPREPLY=( $(compgen -W "--force --json" -- "\${cur}") )
          return 0
          ;;
      esac
      ;;
    audit)
      case "\${prev}" in
        --coverage|-C)
          COMPREPLY=( $(compgen -W "quick surface full" -- "\${cur}") )
          return 0
          ;;
        --visibility)
          COMPREPLY=( $(compgen -W "public unlisted private" -- "\${cur}") )
          return 0
          ;;
        --render-mode)
          COMPREPLY=( $(compgen -W "off auto all" -- "\${cur}") )
          return 0
          ;;
        --format|-f)
          COMPREPLY=( $(compgen -W "${formatValues}" -- "\${cur}") )
          return 0
          ;;
      esac
      COMPREPLY=( $(compgen -W "--max-pages -m --max-depth --concurrency --per-host --coverage -C --format -f --output -o --refresh -r --fresh-ua --incremental --no-incremental --resume --verbose -v --debug --trace --project-name -n --publish -p --no-publish --visibility --yes -y --render --render-mode --http --offline --fail-on --header -H --rule-include --rule-exclude --summary --help" -- "\${cur}") )
      return 0
      ;;
    crawl)
      case "\${prev}" in
        --coverage|-C)
          COMPREPLY=( $(compgen -W "quick surface full" -- "\${cur}") )
          return 0
          ;;
      esac
      COMPREPLY=( $(compgen -W "--max-pages -m --concurrency --per-host --coverage -C --refresh -r --fresh-ua --resume --help" -- "\${cur}") )
      return 0
      ;;
    analyze)
      COMPREPLY=( $(compgen -W "--id --help" -- "\${cur}") )
      return 0
      ;;
    init)
      COMPREPLY=( $(compgen -W "--force --project-name -n --help" -- "\${cur}") )
      return 0
      ;;
    report)
      case "\${prev}" in
        --category)
          COMPREPLY=( $(compgen -W "${categoryValues}" -- "\${cur}") )
          return 0
          ;;
        --severity)
          COMPREPLY=( $(compgen -W "error warning all" -- "\${cur}") )
          return 0
          ;;
        --format|-f)
          COMPREPLY=( $(compgen -W "${formatValues}" -- "\${cur}") )
          return 0
          ;;
        --visibility)
          COMPREPLY=( $(compgen -W "public unlisted private" -- "\${cur}") )
          return 0
          ;;
      esac
      COMPREPLY=( $(compgen -W "--list -l --severity --category --format -f --diff --regression-since --allow-cross-site --output -o --input -i --publish -p --visibility --summary --help" -- "\${cur}") )
      return 0
      ;;
    feedback)
      case "\${prev}" in
        --category)
          COMPREPLY=( $(compgen -W "${feedbackCategoryValues}" -- "\${cur}") )
          return 0
          ;;
      esac
      COMPREPLY=( $(compgen -W "--category --help" -- "\${cur}") )
      return 0
      ;;
    *)
      if [[ "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "\${global_opts}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      fi
      return 0
      ;;
  esac
}

complete -F _squirrel_completions squirrel
`;
}

function generateZshCompletion(): string {
  return `#compdef squirrel
# squirrel zsh completion
# Add to ~/.zshrc: eval "$(squirrel self completion zsh)"

_squirrel() {
  local -a commands self_commands config_commands global_opts

  global_opts=(
    '(-c --config-file)'{-c,--config-file}'[Path to config file]:file:_files -g "*.toml"'
  )

  commands=(
    'audit:Run audit on a URL'
    'auth:Authentication commands'
    'crawl:Crawl a website (no analysis)'
    'credits:Show cloud credit balance and pricing'
    'analyze:Run audit rules on stored crawl'
    'init:Initialize squirrel.toml'
    'config:Manage configuration'
    'report:Generate report from audit results'
    'feedback:Send feedback to the team'
    'keys:Manage org API keys'
    'mcp:Run the local MCP server (stdio)'
    'self:Self-management commands'
    'skills:Manage agent skills'
  )

  auth_commands=(
    'login:Authenticate with squirrelscan'
    'logout:Sign out and revoke token'
    'status:Show authentication status'
    'whoami:Show the active credential (source, scopes, org)'
  )

  keys_commands=(
    'create:Mint an org API key for headless / CI use'
    'list:List org API keys'
    'revoke:Revoke an org API key by prefix or id'
  )

  self_commands=(
    'install:Bootstrap local installation'
    'update:Check and apply updates'
    'completion:Generate shell completions'
    'doctor:Run health checks'
    'version:Show version information'
    'settings:Manage CLI settings'
    'uninstall:Remove squirrel from the system'
  )

  settings_commands=(
    'show:Show current settings'
    'set:Set a settings value'
  )

  config_commands=(
    'show:Display current configuration'
    'set:Update a configuration value'
    'path:Show config file location'
    'validate:Validate config file'
  )

  skills_commands=(
    'install:Install squirrelscan skills for coding agents'
    'update:Update squirrelscan skills for coding agents'
  )

  _arguments -C \\
    \${global_opts} \\
    '1: :->command' \\
    '*:: :->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        self)
          case $words[2] in
            completion)
              _values 'shell' 'bash' 'zsh' 'fish'
              ;;
            update)
              _arguments \\
                '--check[Only check for updates]' \\
                '--dismiss[Dismiss update notification]' \\
                '--force[Update even if not a managed install]'
              ;;
            version)
              _arguments '--json[Output as JSON]'
              ;;
            settings)
              case $words[3] in
                show)
                  _arguments \\
                    '--local[Show only local project settings]' \\
                    '--user[Show only user settings]'
                  ;;
                set)
                  _arguments \\
                    '1:key:(channel auto_update update_check_interval_hours notifications telemetry tips)' \\
                    '2:value:' \\
                    '--local[Set in local project settings]' \\
                    '--user[Set in user settings]'
                  ;;
                *)
                  _describe 'settings command' settings_commands
                  ;;
              esac
              ;;
            uninstall)
              _arguments \\
                '--purge[Also remove user settings]' \\
                '--force[Skip confirmation prompt]'
              ;;
            install)
              _arguments \\
                '--bin-dir[Custom bin directory for symlink]:directory:_files -/'
              ;;
            *)
              _describe 'self command' self_commands
              ;;
          esac
          ;;
        config)
          _describe 'config command' config_commands
          ;;
        skills)
          _describe 'skills command' skills_commands
          ;;
        auth)
          case $words[2] in
            login)
              _arguments \\
                '(-d --device-name)'{-d,--device-name}'[Name for this device]:name'
              ;;
            status|whoami)
              _arguments '--json[Output as JSON]'
              ;;
            *)
              _describe 'auth command' auth_commands
              ;;
          esac
          ;;
        keys)
          case $words[2] in
            create)
              _arguments \\
                '--name[Key name]:name' \\
                '--scopes[Comma-separated scopes]:scopes' \\
                '--expires-days[Days until expiry]:days' \\
                '--shell[Append the export line to your shell rc file]' \\
                '--json[Output as JSON]'
              ;;
            list)
              _arguments '--json[Output as JSON]'
              ;;
            revoke)
              _arguments \\
                '1:key prefix or id:' \\
                '--force[Skip confirmation prompt]' \\
                '--json[Output as JSON]'
              ;;
            *)
              _describe 'keys command' keys_commands
              ;;
          esac
          ;;
        audit)
          _arguments \\
            '1:url:_urls' \\
            '(-m --max-pages)'{-m,--max-pages}'[Maximum pages to crawl]:number' \\
            '--max-depth[Maximum crawl depth from the seed]:number' \\
            '--concurrency[Global crawl worker pool size]:number' \\
            '--per-host[Max concurrent requests per host]:number' \\
            '(-C --coverage)'{-C,--coverage}'[Coverage mode]:mode:(quick surface full)' \\
            '(-f --format)'{-f,--format}'[Output format]:format:(${formatValues})' \\
            '(-o --output)'{-o,--output}'[Output file path]:file:_files' \\
            '(-r --refresh)'{-r,--refresh}'[Ignore cache, fetch all pages fresh]' \\
            '--fresh-ua[Re-roll the pinned random user-agent]' \\
            '--incremental[Re-scan only changed pages via conditional GET (default on)]' \\
            '--no-incremental[Fetch every page in full, disabling conditional GET]' \\
            '--resume[Resume interrupted crawl]' \\
            '(-v --verbose)'{-v,--verbose}'[Verbose output]' \\
            '--debug[Enable debug logging]' \\
            '--trace[Enable performance tracing]' \\
            '(-n --project-name)'{-n,--project-name}'[Project name (overrides config and prompts)]:name' \\
            '(-p --publish)'{-p,--publish}'[Publish to reports.squirrelscan.com (default when signed in)]' \\
            '--no-publish[Skip auto-publishing this run]' \\
            '--visibility[Visibility for published reports]:visibility:(public unlisted private)' \\
            '(-y --yes)'{-y,--yes}'[Skip confirmation prompts]' \\
            '--render[Force cloud browser rendering for this run]' \\
            '--render-mode[Render strategy]:mode:(off auto all)' \\
            '--http[Force plain HTTP fetch for this run]' \\
            '--offline[Run fully offline: no cloud, publishing, or telemetry]' \\
            '*--fail-on[Exit 2 when a threshold trips (e.g. score<90, severity>=error)]:expr' \\
            '*'{-H,--header}'[Custom HTTP header on every crawl request, format "Name: Value" (repeatable)]:header' \\
            '*--rule-include[Only run these rule categories or rules]:pattern' \\
            '*--rule-exclude[Skip these rule categories or rules]:pattern' \\
            '--summary[Print score, category breakdown, and issue counts only]'
          ;;
        crawl)
          _arguments \\
            '1:url:_urls' \\
            '(-m --max-pages)'{-m,--max-pages}'[Maximum pages to crawl]:number' \\
            '--concurrency[Global crawl worker pool size]:number' \\
            '--per-host[Max concurrent requests per host]:number' \\
            '(-C --coverage)'{-C,--coverage}'[Coverage mode]:mode:(quick surface full)' \\
            '(-r --refresh)'{-r,--refresh}'[Ignore cache, fetch all pages fresh]' \\
            '--fresh-ua[Re-roll the pinned random user-agent]' \\
            '--resume[Resume interrupted crawl]'
          ;;
        analyze)
          _arguments \\
            '--id[Crawl ID to analyze]:crawl-id:'
          ;;
        feedback)
          _arguments \\
            '--category[Feedback category]:category:(${feedbackCategoryValues})'
          ;;
        init)
          _arguments \\
            '--force[Overwrite existing config]' \\
            '(-n --project-name)'{-n,--project-name}'[Project name]:name'
          ;;
        report)
          _arguments \\
            '1:audit id (UUID or prefix) or domain:' \\
            '(-l --list)'{-l,--list}'[List recent audits]' \\
            '--severity[Filter by severity]:severity:(error warning all)' \\
            '--category[Filter by categories]:category:(${categoryValues})' \\
            '(-f --format)'{-f,--format}'[Output format]:format:(${formatValues})' \\
            '--diff[Compare against baseline audit]:audit-id:' \\
            '--regression-since[Compare against baseline and show regressions]:audit-id:' \\
            '--allow-cross-site[Allow diff across different base URLs]' \\
            '(-o --output)'{-o,--output}'[Output file path]:file:_files' \\
            '(-i --input)'{-i,--input}'[Load from JSON file]:file:_files -g "*.json"' \\
            '(-p --publish)'{-p,--publish}'[Publish to reports.squirrelscan.com]' \\
            '--visibility[Visibility when publishing]:visibility:(public unlisted private)' \\
            '--summary[Print score, category breakdown, and issue counts only]'
          ;;
      esac
      ;;
  esac
}

compdef _squirrel squirrel
`;
}

function generateFishCompletion(): string {
  return `# squirrel fish completion
# Add to ~/.config/fish/completions/squirrel.fish

# Disable file completion by default
complete -c squirrel -f

# Global options (apply to all commands)
complete -c squirrel -s c -l config-file -d "Path to config file" -r

# Top-level commands
complete -c squirrel -n "__fish_use_subcommand" -a audit -d "Run audit on a URL"
complete -c squirrel -n "__fish_use_subcommand" -a auth -d "Authentication commands"
complete -c squirrel -n "__fish_use_subcommand" -a crawl -d "Crawl a website (no analysis)"
complete -c squirrel -n "__fish_use_subcommand" -a credits -d "Show cloud credit balance and pricing"
complete -c squirrel -n "__fish_use_subcommand" -a analyze -d "Run audit rules on stored crawl"
complete -c squirrel -n "__fish_use_subcommand" -a init -d "Initialize squirrel.toml"
complete -c squirrel -n "__fish_use_subcommand" -a config -d "Manage configuration"
complete -c squirrel -n "__fish_use_subcommand" -a report -d "Generate report from audit results"
complete -c squirrel -n "__fish_use_subcommand" -a feedback -d "Send feedback to the team"
complete -c squirrel -n "__fish_use_subcommand" -a keys -d "Manage org API keys"
complete -c squirrel -n "__fish_use_subcommand" -a mcp -d "Run the local MCP server (stdio)"
complete -c squirrel -n "__fish_use_subcommand" -a self -d "Self-management commands"
complete -c squirrel -n "__fish_use_subcommand" -a skills -d "Manage agent skills"

# Auth subcommands
complete -c squirrel -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status whoami" -a login -d "Authenticate with squirrelscan"
complete -c squirrel -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status whoami" -a logout -d "Sign out and revoke token"
complete -c squirrel -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status whoami" -a status -d "Show authentication status"
complete -c squirrel -n "__fish_seen_subcommand_from auth; and not __fish_seen_subcommand_from login logout status whoami" -a whoami -d "Show the active credential (source, scopes, org)"

# Auth login options
complete -c squirrel -n "__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from login" -s d -l device-name -d "Name for this device"

# Auth status options
complete -c squirrel -n "__fish_seen_subcommand_from auth; and __fish_seen_subcommand_from status whoami" -l json -d "Output as JSON"

# Keys subcommands
complete -c squirrel -n "__fish_seen_subcommand_from keys; and not __fish_seen_subcommand_from create list revoke" -a create -d "Mint an org API key for headless / CI use"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and not __fish_seen_subcommand_from create list revoke" -a list -d "List org API keys"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and not __fish_seen_subcommand_from create list revoke" -a revoke -d "Revoke an org API key by prefix or id"

# Keys create options
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create" -l name -d "Key name"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create" -l scopes -d "Comma-separated scopes"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create" -l expires-days -d "Days until expiry"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create" -l shell -d "Append the export line to your shell rc file"
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create list revoke" -l json -d "Output as JSON"

# Keys revoke options
complete -c squirrel -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from revoke" -l force -d "Skip confirmation prompt"

# Self subcommands
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a install -d "Bootstrap local installation"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a update -d "Check and apply updates"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a completion -d "Generate shell completions"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a doctor -d "Run health checks"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a version -d "Show version information"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings auth uninstall" -a settings -d "Manage CLI settings"
complete -c squirrel -n "__fish_seen_subcommand_from self; and not __fish_seen_subcommand_from install update completion doctor version settings uninstall" -a uninstall -d "Remove squirrel from the system"

# Shell completion options
complete -c squirrel -n "__fish_seen_subcommand_from completion" -a "bash zsh fish" -d "Shell type"

# Skills subcommands
complete -c squirrel -n "__fish_seen_subcommand_from skills; and not __fish_seen_subcommand_from install update" -a install -d "Install squirrelscan skills for coding agents"
complete -c squirrel -n "__fish_seen_subcommand_from skills; and not __fish_seen_subcommand_from install update" -a update -d "Update squirrelscan skills for coding agents"

# Feedback options
complete -c squirrel -n "__fish_seen_subcommand_from feedback" -l category -d "Feedback category" -xa "${feedbackCategoryValues}"

# Update options
complete -c squirrel -n "__fish_seen_subcommand_from update" -l check -d "Only check for updates"
complete -c squirrel -n "__fish_seen_subcommand_from update" -l dismiss -d "Dismiss update notification"
complete -c squirrel -n "__fish_seen_subcommand_from update" -l force -d "Update even if not a managed install"

# Version options
complete -c squirrel -n "__fish_seen_subcommand_from version" -l json -d "Output as JSON"

# Settings subcommands
complete -c squirrel -n "__fish_seen_subcommand_from settings; and not __fish_seen_subcommand_from show set" -a show -d "Show current settings"
complete -c squirrel -n "__fish_seen_subcommand_from settings; and not __fish_seen_subcommand_from show set" -a set -d "Set a settings value"

# Settings show options
complete -c squirrel -n "__fish_seen_subcommand_from settings; and __fish_seen_subcommand_from show" -l local -d "Show only local project settings"
complete -c squirrel -n "__fish_seen_subcommand_from settings; and __fish_seen_subcommand_from show" -l user -d "Show only user settings"

# Settings set options
complete -c squirrel -n "__fish_seen_subcommand_from settings; and __fish_seen_subcommand_from set" -a "channel auto_update update_check_interval_hours notifications telemetry tips" -d "Setting key"
complete -c squirrel -n "__fish_seen_subcommand_from settings; and __fish_seen_subcommand_from set" -l local -d "Set in local project settings"
complete -c squirrel -n "__fish_seen_subcommand_from settings; and __fish_seen_subcommand_from set" -l user -d "Set in user settings"

# Uninstall options
complete -c squirrel -n "__fish_seen_subcommand_from uninstall" -l purge -d "Also remove user settings"
complete -c squirrel -n "__fish_seen_subcommand_from uninstall" -l force -d "Skip confirmation prompt"

# Install options
complete -c squirrel -n "__fish_seen_subcommand_from install" -l bin-dir -d "Custom bin directory for symlink"

# Config subcommands
complete -c squirrel -n "__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from show set path validate" -a show -d "Display current configuration"
complete -c squirrel -n "__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from show set path validate" -a set -d "Update a configuration value"
complete -c squirrel -n "__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from show set path validate" -a path -d "Show config file location"
complete -c squirrel -n "__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from show set path validate" -a validate -d "Validate config file"

# Config set options
complete -c squirrel -n "__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set" -l dry-run -d "Preview change without writing"

# Audit options
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s m -l max-pages -d "Maximum pages to crawl"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l max-depth -d "Maximum crawl depth from the seed"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l concurrency -d "Global crawl worker pool size"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l per-host -d "Max concurrent requests per host"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s C -l coverage -a "quick surface full" -d "Coverage mode"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s f -l format -a "${formatValues}" -d "Output format"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s o -l output -d "Output file path"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s r -l refresh -d "Ignore cache, fetch all pages fresh"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l fresh-ua -d "Re-roll the pinned random user-agent"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l incremental -d "Re-scan only changed pages via conditional GET (default on)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l no-incremental -d "Fetch every page in full, disabling conditional GET"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l resume -d "Resume interrupted crawl"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s v -l verbose -d "Verbose output"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l debug -d "Enable debug logging"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l trace -d "Enable performance tracing"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s n -l project-name -d "Project name (overrides config and prompts)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s p -l publish -d "Publish to reports.squirrelscan.com (default when signed in)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l no-publish -d "Skip auto-publishing this run"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l visibility -a "public unlisted private" -d "Visibility for published reports"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s y -l yes -d "Skip confirmation prompts (cloud credit spend)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l render -d "Force cloud browser rendering for this run"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l render-mode -a "off auto all" -d "Render strategy"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l http -d "Force plain HTTP fetch for this run"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l offline -d "Run fully offline: no cloud, publishing, or telemetry"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l fail-on -d "Exit 2 when a threshold trips (e.g. score<90, severity>=error)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -s H -l header -d "Custom HTTP header on every crawl request, format \\"Name: Value\\" (repeatable)"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l rule-include -d "Only run these rule categories or rules"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l rule-exclude -d "Skip these rule categories or rules"
complete -c squirrel -n "__fish_seen_subcommand_from audit" -l summary -d "Print score, category breakdown, and issue counts only"
complete -c squirrel -n "__fish_seen_subcommand_from credits" -l json -d "Output as JSON"

# Crawl options
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -s m -l max-pages -d "Maximum pages to crawl"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -l concurrency -d "Global crawl worker pool size"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -l per-host -d "Max concurrent requests per host"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -s C -l coverage -a "quick surface full" -d "Coverage mode"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -s r -l refresh -d "Ignore cache, fetch all pages fresh"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -l fresh-ua -d "Re-roll the pinned random user-agent"
complete -c squirrel -n "__fish_seen_subcommand_from crawl" -l resume -d "Resume interrupted crawl"

# Analyze options
complete -c squirrel -n "__fish_seen_subcommand_from analyze" -l id -d "Crawl ID to analyze"

# Init options
complete -c squirrel -n "__fish_seen_subcommand_from init" -l force -d "Overwrite existing config"
complete -c squirrel -n "__fish_seen_subcommand_from init" -s n -l project-name -d "Project name"

# Report options
complete -c squirrel -n "__fish_seen_subcommand_from report" -s l -l list -d "List recent audits"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l severity -a "error warning all" -d "Filter by severity"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l category -a "${categoryValues}" -d "Filter by categories (comma-separated)"
complete -c squirrel -n "__fish_seen_subcommand_from report" -s f -l format -a "${formatValues}" -d "Output format"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l diff -d "Compare against baseline audit"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l regression-since -d "Compare against baseline and show regressions"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l allow-cross-site -d "Allow diff across different base URLs"
complete -c squirrel -n "__fish_seen_subcommand_from report" -s o -l output -d "Output file path"
complete -c squirrel -n "__fish_seen_subcommand_from report" -s i -l input -d "Load from JSON file"
complete -c squirrel -n "__fish_seen_subcommand_from report" -s p -l publish -d "Publish to reports.squirrelscan.com"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l visibility -a "public unlisted private" -d "Visibility when publishing"
complete -c squirrel -n "__fish_seen_subcommand_from report" -l summary -d "Print score, category breakdown, and issue counts only"
`;
}

/**
 * Get installation instructions for a shell
 */
export function getInstallInstructions(shell: Shell): string {
  switch (shell) {
    case "bash":
      return `# Add to ~/.bashrc:
eval "$(squirrel self completion bash)"

# Or save to a file:
squirrel self completion bash > ~/.local/share/bash-completion/completions/squirrel`;

    case "zsh":
      return `# Add to ~/.zshrc:
eval "$(squirrel self completion zsh)"

# Or save to a file (ensure fpath includes this directory):
squirrel self completion zsh > ~/.zfunc/_squirrel`;

    case "fish":
      return `# Save to fish completions directory:
squirrel self completion fish > ~/.config/fish/completions/squirrel.fish`;
  }
}
