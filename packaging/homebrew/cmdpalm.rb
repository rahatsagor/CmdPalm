# Template for Casks/cmdpalm.rb in github.com/rahatsagor/homebrew-tap.
# The release workflow fills in the version and checksum.
cask "cmdpalm" do
  version "{{VERSION}}"
  sha256 "{{SHA256}}"

  url "https://github.com/rahatsagor/CmdPalm/releases/download/v#{version}/CmdPalm-#{version}.zip"
  name "CmdPalm"
  desc "Use your phone as a trackpad, keyboard and button deck"
  homepage "https://cmdpalm.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "CmdPalm.app"

  # CmdPalm is open source and not notarized by Apple. Removing the quarantine
  # flag lets it open without the "Apple could not verify" prompt.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/CmdPalm.app"]
  end

  uninstall quit: "app.cmdpalm.mac"

  zap trash: [
    "~/Library/Application Support/CmdPalm",
    "~/Library/Caches/app.cmdpalm.mac",
    "~/Library/HTTPStorages/app.cmdpalm.mac",
    "~/Library/Logs/CmdPalm",
    "~/Library/Preferences/app.cmdpalm.mac.plist",
  ]

  caveats <<~EOS
    CmdPalm needs Accessibility permission to move the pointer and type.
    Open CmdPalm and follow the setup steps, or allow it in
    System Settings → Privacy & Security → Accessibility.
  EOS
end
