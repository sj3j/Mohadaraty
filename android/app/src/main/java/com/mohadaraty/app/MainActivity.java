package com.mohadaraty.app;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.annotation.Nullable;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        // Must be called before super.onCreate to switch from
        // AppTheme.NoActionBarLaunch to postSplashScreenTheme (AppTheme.NoActionBar)
        // and safely clear the window splash background drawable.
        SplashScreen.installSplashScreen(this);
        EdgeToEdge.enable(this);
        registerPlugin(SystemBarsPlugin.class);
        registerPlugin(SettingsLauncherPlugin.class);
        registerPlugin(com.mohadaraty.app.attendance.AttendanceStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
