-- 只在调用方已取得账号、描述文件及设备登记授权后触发一次原生构建。
on run argv
    if (count argv) is not 2 then error "需要唯一设备名称和隔离工作目录名称"
    set deviceName to item 1 of argv
    set workdirTag to item 2 of argv
    if workdirTag is "" then error "工作目录标识不能为空"
    tell application id "com.apple.dt.Xcode" to activate
    tell application "System Events"
        tell process "Xcode"
            set frontmost to true
            set docPath to value of attribute "AXDocument" of window 1
            if docPath does not contain workdirTag then error "前台不是指定的隔离工程"
            set destinationMenu to menu 1 of menu item "Destination" of menu 1 of menu bar item "Product" of menu bar 1
            set candidates to {}
            repeat with choice in menu items of destinationMenu
                set labelText to name of choice
                if labelText is not missing value then
                    if labelText starts with (deviceName & " ") then set end of candidates to choice
                end if
            end repeat
            if (count candidates) is not 1 then error "设备菜单没有唯一匹配，停止构建"
            click item 1 of candidates
            set chosenDevice to value of pop up button 2 of list 1 of group 5 of toolbar 1 of window 1
            if chosenDevice is not deviceName then error "目标设备选择未生效"
            click menu item "Build" of menu 1 of menu bar item "Product" of menu bar 1
            return "build-requested"
        end tell
    end tell
end run
