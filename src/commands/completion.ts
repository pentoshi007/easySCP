import { COMMANDS } from '../cli/args.js';

const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string | undefined): value is Shell {
  return SHELLS.includes(value as Shell);
}

const HOST_COMMANDS = ['send', 'receive', 'edit', 'remove', 'test'];

function commandWords(): string[] {
  return COMMANDS.flatMap((command) => [command.name, ...command.aliases]);
}

function hostCommandWords(): string[] {
  return COMMANDS.filter((command) => HOST_COMMANDS.includes(command.name)).flatMap((command) => [
    command.name,
    ...command.aliases,
  ]);
}

export function completionScript(shell: Shell): string {
  const commands = commandWords().join(' ');
  const hostCommands = hostCommandWords().join('|');
  switch (shell) {
    case 'bash':
      return `_easyscp() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${commands} $(easyscp __hosts 2>/dev/null)" -- "$cur"))
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
      ${hostCommands}) COMPREPLY=($(compgen -W "$(easyscp __hosts 2>/dev/null)" -- "$cur")) ;;
      *) COMPREPLY=($(compgen -f -- "$cur")) ;;
    esac
  else
    COMPREPLY=($(compgen -f -- "$cur"))
  fi
}
complete -o default -F _easyscp easyscp escp
`;
    case 'zsh':
      return `#compdef easyscp escp
_easyscp() {
  local -a hosts
  hosts=(\${(f)"$(easyscp __hosts 2>/dev/null)"})
  if (( CURRENT == 2 )); then
    compadd -- ${commands} $hosts
  elif (( CURRENT == 3 )) && [[ "\${words[2]}" == (${hostCommands}) ]]; then
    compadd -- $hosts
  else
    _files
  fi
}
compdef _easyscp easyscp escp
`;
    case 'fish':
      return `function __easyscp_hosts
    easyscp __hosts 2>/dev/null
end
for cmd in easyscp escp
    complete -c $cmd -f -n "__fish_is_nth_token 1" -a "${commands}"
    complete -c $cmd -f -n "__fish_is_nth_token 1" -a "(__easyscp_hosts)"
    complete -c $cmd -f -n "__fish_is_nth_token 2; and __fish_seen_subcommand_from ${hostCommandWords().join(' ')}" -a "(__easyscp_hosts)"
end
`;
    case 'powershell':
      return `Register-ArgumentCompleter -Native -CommandName easyscp, escp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $position = $words.Count
  if ($wordToComplete -ne '') { $position -= 1 }
  $candidates = @()
  if ($position -le 1) {
    $candidates = @(${commandWords()
      .map((word) => `'${word}'`)
      .join(', ')}) + @(easyscp __hosts 2>$null)
  } elseif ($position -eq 2 -and @(${hostCommandWords()
    .map((word) => `'${word}'`)
    .join(', ')}) -contains $words[1]) {
    $candidates = @(easyscp __hosts 2>$null)
  } else {
    return
  }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
  }
}
