import { Detail, getPreferenceValues, OAuth } from "@raycast/api";
import { getAccessToken, OAuthService, withAccessToken } from "@raycast/utils";

const { server } = getPreferenceValues<{ server: string }>();
const client = new OAuth.PKCEClient({ redirectMethod: OAuth.RedirectMethod.Web, providerName: "Test Provider", providerId: "test", description: "Connect Compat Lab to the local test provider" });
const provider = new OAuthService({ client, clientId: "compat-client", scope: "read", authorizeUrl: `${server}/authorize`, tokenUrl: `${server}/token`, bodyEncoding: "url-encoded" });

function Command() {
  const { token } = getAccessToken();
  return <Detail markdown={`# Signed in\n\ntoken=${token}`} />;
}

export default withAccessToken(provider)(Command);
