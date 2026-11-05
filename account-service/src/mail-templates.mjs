// Text-only mail: no HTML, so user-supplied names cannot inject markup.
const link = (config, purpose, token) => `${config.origin}/account/verify#purpose=${purpose}&token=${token}`;
const signIn = (config) => `${config.origin}/account/sign-in`;

export function signupMail(config, to, token) {
  return {
    to,
    subject: 'Confirm your LLM-IDE account',
    text: [
      'Open this link within 15 minutes to finish creating your LLM-IDE account:',
      '',
      link(config, 'signup', token),
      '',
      'The link works once. If you did not ask for an account, ignore this email.',
    ].join('\n'),
  };
}

export function alreadyRegisteredMail(config, to) {
  return {
    to,
    subject: 'You already have an LLM-IDE account',
    text: [
      'Someone asked to create an LLM-IDE account with this address, which already has one.',
      '',
      `Sign in with your passkey at ${signIn(config)}`,
      'Lost your passkey? Use "Lost your passkey?" on that page.',
      '',
      'If this was not you, you can ignore this email.',
    ].join('\n'),
  };
}

export function recoveryMail(config, to, token) {
  return {
    to,
    subject: 'Add a new passkey to your LLM-IDE account',
    text: [
      'Open this link within 15 minutes to add a new passkey:',
      '',
      link(config, 'recovery', token),
      '',
      'Adding a passkey this way signs out every other session.',
      'If you did not ask for this, ignore this email; nothing changes.',
    ].join('\n'),
  };
}

export function passkeyAddedMail(config, to, { viaRecovery }) {
  return {
    to,
    subject: 'A passkey was added to your LLM-IDE account',
    text: [
      viaRecovery
        ? 'A new passkey was added through an email link, and every other session was signed out.'
        : 'A new passkey was added to your account.',
      '',
      `If this was not you, sign in at ${signIn(config)} , remove the passkey, and secure your email account.`,
    ].join('\n'),
  };
}

export function passkeyRemovedMail(config, to) {
  return {
    to,
    subject: 'A passkey was removed from your LLM-IDE account',
    text: `A passkey was removed from your account. If this was not you, sign in at ${signIn(config)} .`,
  };
}

export function accountDeletedMail(config, to) {
  return {
    to,
    subject: 'Your LLM-IDE account was deleted',
    text: 'Your LLM-IDE account and its sign-in data were deleted. Data on your own computer is not affected.',
  };
}
