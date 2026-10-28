param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Web.Extensions
$references = @(
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.Brush].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location,
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
)
Add-Type -Path (Join-Path $PSScriptRoot 'desktop-notification-window.cs') -ReferencedAssemblies $references -OutputAssembly $OutputPath -OutputType ConsoleApplication
