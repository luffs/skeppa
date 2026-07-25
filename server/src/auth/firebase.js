// Validates a Firebase ID token with the Identity Toolkit REST API and returns
// Firebase's account payload ({ users: [...] }). The web API key is public by
// design — it identifies the project, it does not authenticate the caller.
export async function getFirebaseUser({ idToken, apiKey }) {
  const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey)
  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  return response.json()
}
