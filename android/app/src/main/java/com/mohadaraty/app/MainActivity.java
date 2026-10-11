package com.mohadaraty.app;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.annotation.Nullable;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        // BridgeActivity inflates the WebView inside super.onCreate(), so edge
        // to edge must be enabled first for consistent behavior below API 35.
        EdgeToEdge.enable(this);
        registerPlugin(SystemBarsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
