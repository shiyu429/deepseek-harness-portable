using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class UiKit {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    public static void Initialize() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
    }
    public static Icon BrandIcon() {
        return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }
    public static Bitmap BrandImage() {
        byte[] bytes=EmbeddedIcon.Extract(Application.ExecutablePath);int count=BitConverter.ToUInt16(bytes,4),selected=0,best=0;
        for(int i=0;i<count;i++){int entry=6+i*16,w=bytes[entry]==0?256:bytes[entry];if(w>best){best=w;selected=entry;}}
        int size=BitConverter.ToInt32(bytes,selected+8),offset=BitConverter.ToInt32(bytes,selected+12);
        if(bytes[offset]==137&&bytes[offset+1]==80){using(var stream=new MemoryStream(bytes,offset,size))using(var image=Image.FromStream(stream))return new Bitmap(image);}
        using(var stream=new MemoryStream(bytes))using(var icon=new Icon(stream,best,best))return icon.ToBitmap();
    }
}

class CrispForm : Form {
    public float LayoutScale=1;
    public void FitDpi(){float value;using(var g=CreateGraphics())value=g.DpiX/96f;ResizeDpi(value);}
    void ResizeDpi(float value){if(value<=0||Math.Abs(value-LayoutScale)<0.01)return;float ratio=value/LayoutScale;LayoutScale=value;Scale(new SizeF(ratio,ratio));}
    [StructLayout(LayoutKind.Sequential)] struct DpiRect{public int Left,Top,Right,Bottom;}
    protected override void WndProc(ref Message message){
        if(message.Msg==0x02E0){float dpi=(message.WParam.ToInt64()&0xffff)/96f;var rect=(DpiRect)Marshal.PtrToStructure(message.LParam,typeof(DpiRect));SuspendLayout();ResizeDpi(dpi);Bounds=Rectangle.FromLTRB(rect.Left,rect.Top,rect.Right,rect.Bottom);ResumeLayout();return;}
        base.WndProc(ref message);
    }
}

sealed class LoadingRing : Control {
    readonly Timer timer;
    float angle;
    public LoadingRing() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor,true);
        BackColor = Color.White; ForeColor = Color.Black; Size = new Size(32,32);
        timer = new Timer { Interval = 16 };
        timer.Tick += (s,e) => { angle = (angle + 6) % 360; Invalidate(); };
    }
    protected override void OnVisibleChanged(EventArgs e) { base.OnVisibleChanged(e); if (Visible) timer.Start(); else timer.Stop(); }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float width = Math.Max(2, e.Graphics.DpiX / 48), padding = width + 1;
        var rect = new RectangleF(padding,padding,Width-padding*2,Height-padding*2);
        using (var track = new Pen(Color.FromArgb(232,232,232),width)) e.Graphics.DrawEllipse(track,rect);
        using (var pen = new Pen(ForeColor,width) { StartCap=LineCap.Round, EndCap=LineCap.Round }) e.Graphics.DrawArc(pen,rect,angle,105);
    }
    protected override void Dispose(bool disposing) { if(disposing)timer.Dispose(); base.Dispose(disposing); }
}
