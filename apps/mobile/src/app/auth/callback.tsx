import { useEffect } from "react";
import { Linking, Platform, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { oauthRedirectUrl, readParams } from "@/lib/oauth";
import { getSupabase } from "@/lib/supabase";
import { colors } from "@/theme";

// Web: this page is the OAuth popup's last stop; it hands the URL back to
// the login screen that opened it and closes.
if (Platform.OS === "web") WebBrowser.maybeCompleteAuthSession();

/**
 * Where Google and Apple sign-in come back (falcon://auth/callback). The
 * login screen normally receives the URL itself; this covers the app being
 * opened by the link directly.
 */
export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS === "web") return;
    let live = true;
    void (async () => {
      const supabase = getSupabase();
      const url = (await Linking.getInitialURL()) ?? oauthRedirectUrl();
      const code = readParams(url).get("code");
      let ok = false;
      if (supabase && code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
      if (live) router.replace(ok ? "/welcome" : "/login");
    })();
    return () => {
      live = false;
    };
  }, [router]);

  return <View style={{ flex: 1, backgroundColor: colors.background }} />;
}
