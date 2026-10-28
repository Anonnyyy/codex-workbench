using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Markup;
using System.Windows.Interop;
using System.Windows.Threading;

namespace Workbench {
    public class ReminderItem {
        public string id { get; set; }
        public string title { get; set; }
        public string body { get; set; }
        public string notice { get; set; }
    }
    public class ReminderState { public ReminderItem[] items { get; set; } }

    public class ReminderWindow : Window {
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly StackPanel cards = new StackPanel();
        readonly TextBlock count = new TextBlock();
        readonly ScrollViewer scroll = new ScrollViewer();
        readonly ControlTemplate buttonTemplate;
        ReminderItem[] current = new ReminderItem[0];
        bool shuttingDown, artworkLoaded;
        const double FrameOffset = 104;
        static readonly Brush Ink = Brush(255, 241, 245, 255);
        static readonly Brush Muted = Brush(255, 172, 185, 211);
        static readonly Brush Cyan = Brush(255, 153, 232, 245);
        static SolidColorBrush Brush(byte a, byte r, byte g, byte b) { return new SolidColorBrush(Color.FromArgb(a, r, g, b)); }

        public ReminderWindow(bool preview, string artPath) {
            Title = preview ? "Codex 工作台提醒（预览）" : "Codex 工作台提醒";
            WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = preview; ShowActivated = false; Topmost = true;
            AllowsTransparency = true; Background = Brushes.Transparent;
            WindowStartupLocation = WindowStartupLocation.Manual;
            SizeToContent = SizeToContent.Height;
            FontFamily = new FontFamily("Microsoft YaHei UI"); FontSize = 13;
            UseLayoutRounding = true;
            buttonTemplate = (ControlTemplate)XamlReader.Parse(@"
<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='Button'>
 <Border x:Name='chrome' CornerRadius='7' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='{TemplateBinding BorderThickness}' Padding='{TemplateBinding Padding}'>
  <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
 </Border>
 <ControlTemplate.Triggers>
  <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='chrome' Property='Background' Value='#3879BEDD'/><Setter TargetName='chrome' Property='BorderBrush' Value='#7DBCF4FF'/></Trigger>
  <Trigger Property='IsPressed' Value='True'><Setter TargetName='chrome' Property='Background' Value='#506AE7F5'/></Trigger>
  <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='chrome' Property='BorderBrush' Value='#B0A1EAF5'/></Trigger>
 </ControlTemplate.Triggers>
</ControlTemplate>
");
            var root = new Grid { Margin = new Thickness(8) };
            var fill = new LinearGradientBrush(Color.FromArgb(218, 24, 31, 54), Color.FromArgb(215, 43, 36, 68), 90);
            var edge = new LinearGradientBrush(); edge.StartPoint = new Point(0, 0); edge.EndPoint = new Point(1, 1);
            edge.GradientStops.Add(new GradientStop(Color.FromArgb(155, 150, 232, 251), 0));
            edge.GradientStops.Add(new GradientStop(Color.FromArgb(48, 180, 205, 245), 0.52));
            edge.GradientStops.Add(new GradientStop(Color.FromArgb(110, 189, 165, 240), 1));
            var frame = new Border {
                CornerRadius = new CornerRadius(20), Background = fill, BorderBrush = edge,
                BorderThickness = new Thickness(1), Padding = new Thickness(16), Margin = new Thickness(0, FrameOffset, 0, 8),
                Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 4, Opacity = 0.3, Color = Color.FromRgb(9, 13, 30) }
            };
            var content = new DockPanel();
            var header = new StackPanel { Height = 64, Margin = new Thickness(1, 0, 0, 12), HorizontalAlignment = HorizontalAlignment.Left, Width = 165 };
            header.Children.Add(new TextBlock { Text = "工作台提醒", FontSize = 16, Foreground = Ink, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 2, 0, 8) });
            var counterRow = new StackPanel { Orientation = Orientation.Horizontal };
            count.Foreground = Muted; count.FontSize = 11; count.VerticalAlignment = VerticalAlignment.Center;
            counterRow.Children.Add(count);
            var dismiss = MakeButton("全部关闭", "关闭全部提醒"); dismiss.Margin = new Thickness(8, 0, 0, 0); dismiss.FontSize = 10.5; dismiss.Padding = new Thickness(5, 3, 5, 3); dismiss.Foreground = Muted;
            dismiss.Click += delegate { foreach (var item in current) Emit(new { action = "dismiss", id = item.id }); Hide(); };
            counterRow.Children.Add(dismiss); header.Children.Add(counterRow);
            DockPanel.SetDock(header, Dock.Top); content.Children.Add(header);
            scroll.Content = cards; scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            scroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled; scroll.PanningMode = PanningMode.VerticalOnly;
            scroll.Resources.Add(SystemParameters.VerticalScrollBarWidthKey, 5.0);
            scroll.Resources.Add(typeof(ScrollBar), XamlReader.Parse(@"
<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ScrollBar'>
 <Setter Property='Width' Value='5'/><Setter Property='Margin' Value='6,2,0,2'/>
 <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ScrollBar'>
  <Grid Background='Transparent'><Track x:Name='PART_Track' IsDirectionReversed='True' Orientation='{TemplateBinding Orientation}' Minimum='{TemplateBinding Minimum}' Maximum='{TemplateBinding Maximum}' Value='{TemplateBinding Value}' ViewportSize='{TemplateBinding ViewportSize}'>
   <Track.DecreaseRepeatButton><RepeatButton Command='{x:Static ScrollBar.PageUpCommand}' Focusable='False' Opacity='0'/></Track.DecreaseRepeatButton>
   <Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType='Thumb'><Border Background='#608CDDEA' CornerRadius='3'/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb>
   <Track.IncreaseRepeatButton><RepeatButton Command='{x:Static ScrollBar.PageDownCommand}' Focusable='False' Opacity='0'/></Track.IncreaseRepeatButton>
  </Track></Grid>
 </ControlTemplate></Setter.Value></Setter>
</Style>
"));
            content.Children.Add(scroll); frame.Child = content; root.Children.Add(frame);
            if (!String.IsNullOrEmpty(artPath) && File.Exists(artPath)) {
                var source = new BitmapImage(); source.BeginInit(); source.UriSource = new Uri(Path.GetFullPath(artPath)); source.CacheOption = BitmapCacheOption.OnLoad; source.EndInit(); source.Freeze();
                var mascot = new Image { Source = source, Width = 182, Height = 182, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 0, 10, 0), IsHitTestVisible = false };
                RenderOptions.SetBitmapScalingMode(mascot, BitmapScalingMode.HighQuality);
                root.Children.Add(mascot); artworkLoaded = true;
            }
            Content = root;
            Closing += (sender, e) => { if (!shuttingDown) { e.Cancel = true; foreach (var item in current) Emit(new { action = "dismiss", id = item.id }); Hide(); } };
            SizeChanged += delegate { Position(); ReportLayout(); };
            var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            timer.Tick += delegate { if (IsVisible) Position(); }; timer.Start();
        }
        Button MakeButton(string label, string accessibleName) {
            var button = new Button { Content = label, Template = buttonTemplate, Padding = new Thickness(9, 5, 9, 5), BorderThickness = new Thickness(1), BorderBrush = Brushes.Transparent, Background = Brushes.Transparent, Foreground = Cyan, Cursor = System.Windows.Input.Cursors.Hand };
            AutomationProperties.SetName(button, accessibleName); return button;
        }
        void Position() {
            Rect area = SystemParameters.WorkArea;
            Width = Math.Max(240, Math.Min(392, area.Width - 32));
            MaxHeight = Math.Max(280, Math.Min(520, area.Height * 0.45));
            // Includes mascot space, glass border, header and shadow margins.
            scroll.MaxHeight = Math.Max(40, MaxHeight - FrameOffset - 136);
            Left = area.Right - Width - 16; Top = area.Top + 16;
        }
        void ReportLayout() {
            if (!IsVisible) return;
            Rect area = SystemParameters.WorkArea;
            Emit(new { action = "layout", left = Left, top = Top, width = ActualWidth, height = ActualHeight, workTop = area.Top, workRight = area.Right, workBottom = area.Bottom, showActivated = ShowActivated, visible = IsWindowVisible(new WindowInteropHelper(this).Handle), theme = "tairitsu-glass", transparent = AllowsTransparency, artworkLoaded = artworkLoaded });
        }
        string NoticeLabel(string notice) {
            switch (notice) {
                case "completed": return "已完成";
                case "question": return "等待你回答";
                case "attention": return "需要处理";
                case "error": return "出错";
                case "interrupted": return "已中断";
                default: return "提醒";
            }
        }
        void Apply(ReminderState state) {
            current = state.items ?? new ReminderItem[0];
            if (current.Length == 0) { Hide(); return; }
            cards.Children.Clear(); count.Text = current.Length + " 条提醒";
            foreach (var item in current) {
                var card = new StackPanel();
                var top = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
                var close = MakeButton("×", "关闭提醒：" + item.title); close.FontSize = 16; close.Padding = new Thickness(5, 0, 5, 0); close.Foreground = Muted;
                close.Click += delegate { Emit(new { action = "dismiss", id = item.id }); };
                DockPanel.SetDock(close, Dock.Right); top.Children.Add(close);
                var label = NoticeLabel(item.notice);
                var status = new Border { CornerRadius = new CornerRadius(5), Background = Brush(24, 153, 232, 245), Padding = new Thickness(6, 3, 6, 3), Margin = new Thickness(0, 0, 4, 0), Child = new TextBlock { Text = label, FontSize = 10, Foreground = Cyan } };
                DockPanel.SetDock(status, Dock.Right); top.Children.Add(status);
                string device = (item.title ?? "工作台").Replace("Codex 工作台 · ", "");
                top.Children.Add(new TextBlock { Text = device, Foreground = Muted, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center });
                card.Children.Add(top);
                string[] parts = (item.body ?? "").Split(new char[] {'\n'}, 2);
                string folder = parts.Length == 2 ? parts[0].Replace("文件夹：", "") : "";
                string title = parts.Length == 2 ? parts[1] : parts[0];
                string suffix = " · " + label; if (title.EndsWith(suffix)) title = title.Substring(0, title.Length - suffix.Length);
                card.Children.Add(new TextBlock { Text = title, Foreground = Ink, FontSize = 13, FontWeight = FontWeights.Medium, TextWrapping = TextWrapping.Wrap, LineHeight = 20, MaxHeight = 60, TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = title });
                if (folder.Length > 0) card.Children.Add(new TextBlock { Text = folder, FontSize = 10.5, Foreground = Muted, Margin = new Thickness(0, 5, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = folder });
                var open = MakeButton("查看任务  ↗", "打开任务：" + item.title); open.HorizontalAlignment = HorizontalAlignment.Left; open.Margin = new Thickness(0, 10, 0, 0); open.FontSize = 11;
                open.Background = Brush(24, 129, 207, 239); open.BorderBrush = Brush(60, 150, 224, 245);
                open.Click += delegate { Emit(new { action = "open", id = item.id }); }; card.Children.Add(open);
                cards.Children.Add(new Border { Child = card, CornerRadius = new CornerRadius(12), Padding = new Thickness(12, 10, 12, 12), BorderThickness = new Thickness(1), BorderBrush = Brush(30, 185, 205, 240), Background = Brush(26, 137, 153, 205), Margin = new Thickness(0, 0, 0, 10) });
            }
            Position(); if (!IsVisible) Show();
            Dispatcher.BeginInvoke(new Action(ReportLayout), DispatcherPriority.Loaded);
        }
        void Emit(object value) { lock (Console.Out) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
        [STAThread]
        public static void Main(string[] args) {
            Console.InputEncoding = new System.Text.UTF8Encoding(false);
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            string art = null; int artIndex = Array.IndexOf(args, "--art"); if (artIndex >= 0 && artIndex + 1 < args.Length) art = args[artIndex + 1];
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var window = new ReminderWindow(Array.IndexOf(args, "--preview") >= 0, art);
            var reader = new Thread(delegate() {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (String.IsNullOrWhiteSpace(line)) continue;
                        var state = new JavaScriptSerializer().Deserialize<ReminderState>(line);
                        if (state == null) continue;
                        window.Dispatcher.Invoke(new Action(delegate { window.Apply(state); }));
                    }
                } catch (Exception error) { Console.Error.WriteLine(error.Message); }
                window.Dispatcher.BeginInvoke(new Action(delegate { window.shuttingDown = true; app.Shutdown(); }));
            });
            reader.IsBackground = true; reader.Start();
            window.Emit(new { action = "ready" }); app.Run();
        }
    }
}
