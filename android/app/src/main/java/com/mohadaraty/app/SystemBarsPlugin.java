package com.mohadaraty.app;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Keeps status-bar and navigation-bar icon contrast aligned with the web app's own theme in edge-to-edge mode. */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {
    @PluginMethod
    public void setStyle(PluginCall call) {
        boolean darkBackground = Boolean.TRUE.equals(call.getBoolean("darkBackground", false));
        getActivity().runOnUiThread(() -> {
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(
                getActivity().getWindow(),
                getActivity().getWindow().getDecorView()
            );
            controller.setAppearanceLightStatusBars(!darkBackground);
            controller.setAppearanceLightNavigationBars(!darkBackground);
            JSObject result = new JSObject();
            result.put("darkBackground", darkBackground);
            call.resolve(result);
        });
    }
}
