// Cognito PreSignUp trigger — automatic account linking.
//
// Problem it solves: a native (email/password) user and a federated Google user
// with the SAME email were created as TWO separate User Pool profiles → two
// different `sub`s → the app treated them as two accounts with separate data.
//
// This trigger fires on the FIRST Google sign-in for a given identity
// (triggerSource === 'PreSignUp_ExternalProvider'). If a native user with the
// same email already exists, we link the Google identity INTO that native user
// via AdminLinkProviderForUser. Cognito then signs the user in AS the native
// user (same `sub`) and does NOT create a separate external profile — so there
// is only ever one account per email.
//
// Native sign-ups (PreSignUp_SignUp / PreSignUp_AdminCreateUser) are passed
// through untouched, preserving the existing email-verification behavior.
//
// Runtime: nodejs20.x (the AWS SDK v3 is provided by the runtime — no bundling).

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

export const handler = async (event) => {
  // Only act on the first external-IdP sign-in. Everything else passes through.
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') {
    return event;
  }

  const email = (event.request?.userAttributes?.email || '').toLowerCase();

  // event.userName looks like "Google_1029..." → provider + provider's subject id.
  const userName = event.userName || '';
  const sep = userName.indexOf('_');
  const providerName = sep > 0 ? userName.slice(0, sep) : userName; // "Google"
  const providerUserId = sep > 0 ? userName.slice(sep + 1) : '';      // numeric Google sub

  try {
    if (email && providerUserId) {
      // Find an existing NATIVE user with this email to link into.
      const list = await client.send(new ListUsersCommand({
        UserPoolId: event.userPoolId,
        Filter: `email = "${email}"`,
        Limit: 20,
      }));

      const native = (list.Users || []).find((u) =>
        u.UserStatus !== 'EXTERNAL_PROVIDER' &&
        !(u.Username || '').startsWith('Google_'),
      );

      if (native) {
        await client.send(new AdminLinkProviderForUserCommand({
          UserPoolId: event.userPoolId,
          // Destination = the existing native user (canonical account).
          DestinationUser: {
            ProviderName: 'Cognito',
            ProviderAttributeValue: native.Username,
          },
          // Source = the incoming Google identity, matched by its subject id.
          SourceUser: {
            ProviderName: providerName,        // "Google"
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: providerUserId,
          },
        }));
        console.log(`Linked ${providerName} identity ${providerUserId} -> native user ${native.Username} (${email})`);
      }
    }
  } catch (err) {
    // Never block sign-in on a linking failure — worst case we fall back to the
    // pre-existing behavior (a separate profile). Log for diagnosis.
    console.error('Account-link attempt failed:', err);
  }

  // Let the federated sign-in proceed (email is already trusted/verified by Google).
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
