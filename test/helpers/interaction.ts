import type { HostKeyQuestion, Interaction, SecretQuestion } from '../../src/ssh/interaction.js';

export interface ScriptedInteraction extends Interaction {
  hostKeys: HostKeyQuestion[];
  secrets: SecretQuestion[];
}

export function scripted(options: { trust?: boolean; answers?: (string | undefined)[] } = {}) {
  const answers = [...(options.answers ?? [])];
  const interaction: ScriptedInteraction = {
    hostKeys: [],
    secrets: [],
    confirmHostKey: async (question) => {
      interaction.hostKeys.push(question);
      return options.trust ?? true;
    },
    askSecret: async (question) => {
      interaction.secrets.push(question);
      return answers.shift();
    },
    status: () => {},
  };
  return interaction;
}
