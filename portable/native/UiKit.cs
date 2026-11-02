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
    bool layoutReady;
    Screen launchScreen;
    Cursor handCursor;
    IntPtr handHandle;
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index,uint dpi);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr CopyImage(IntPtr image,uint type,int width,int height,uint flags);
    [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
    public Cursor ActionCursor { get { return handCursor??Cursors.Hand; } }
    public static Rectangle FitBounds(Rectangle proposed,Rectangle work,bool center) {
        int mx=Math.Min(Math.Max(16,work.Width/20),work.Width/4),my=Math.Min(Math.Max(16,work.Height/20),work.Height/4);
        int width=Math.Min(proposed.Width,Math.Max(1,work.Width-mx*2));
        int height=Math.Min(proposed.Height,Math.Max(1,work.Height-my*2));
        int x=center?work.Left+(work.Width-width)/2:Math.Max(work.Left+mx,Math.Min(proposed.Left,work.Right-mx-width));
        int y=center?work.Top+(work.Height-height)/2:Math.Max(work.Top+my,Math.Min(proposed.Top,work.Bottom-my-height));
        return new Rectangle(x,y,width,height);
    }
    public void FitDpi(){
        launchScreen=Screen.FromPoint(Cursor.Position);StartPosition=FormStartPosition.Manual;
        Location=launchScreen.WorkingArea.Location;
        float value;try{value=GetDpiForWindow(Handle)/96f;}catch(EntryPointNotFoundException){using(var g=CreateGraphics())value=g.DpiX/96f;}
        layoutReady=true;ResizeDpi(value);Place(launchScreen.WorkingArea,true);
    }
    void Place(Rectangle work,bool center){var target=FitBounds(Bounds,work,center);MinimumSize=new Size(Math.Min(MinimumSize.Width,target.Width),Math.Min(MinimumSize.Height,target.Height));Bounds=target;}
    void ResizeDpi(float value){
        if(value<=0)return;
        if(Math.Abs(value-LayoutScale)>=0.01){var location=Location;float ratio=value/LayoutScale;LayoutScale=value;Scale(new SizeF(ratio,ratio));Location=location;}
        var previous=handCursor;IntPtr previousHandle=handHandle;
        int width,height;try{width=GetSystemMetricsForDpi(13,(uint)(value*96));height=GetSystemMetricsForDpi(14,(uint)(value*96));}catch(EntryPointNotFoundException){width=height=(int)Math.Round(32*value);}
        handHandle=CopyImage(Cursors.Hand.Handle,2,width,height,0);
        if(handHandle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        handCursor=new Cursor(handHandle);
        Action<Control> update=null;update=c=>{foreach(Control child in c.Controls){if(child.Cursor==Cursors.Hand||child.Cursor==previous)child.Cursor=ActionCursor;update(child);}};update(this);
        if(previous!=null)previous.Dispose();if(previousHandle!=IntPtr.Zero)DestroyCursor(previousHandle);
        OnDpiLayoutChanged();
    }
    protected virtual void OnDpiLayoutChanged() { }
    protected override void OnShown(EventArgs e){base.OnShown(e);if(layoutReady)Place(launchScreen.WorkingArea,true);}
    [StructLayout(LayoutKind.Sequential)] struct DpiRect{public int Left,Top,Right,Bottom;}
    protected override void WndProc(ref Message message){
        if(message.Msg==0x02E0&&layoutReady){float dpi=(message.WParam.ToInt64()&0xffff)/96f;var rect=(DpiRect)Marshal.PtrToStructure(message.LParam,typeof(DpiRect));SuspendLayout();ResizeDpi(dpi);Bounds=Rectangle.FromLTRB(rect.Left,rect.Top,rect.Right,rect.Bottom);Place(Screen.FromRectangle(Bounds).WorkingArea,false);ResumeLayout();return;}
        base.WndProc(ref message);
    }
    protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing){if(handCursor!=null)handCursor.Dispose();if(handHandle!=IntPtr.Zero){DestroyCursor(handHandle);handHandle=IntPtr.Zero;}}}
}

// Standard flat buttons paint dark disabled text even on a black background.
// Draw both states explicitly so labels remain readable during an operation.
sealed class ActionButton : Button {
    public bool Primary;
    public ActionButton() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); }
    protected override void OnPaint(PaintEventArgs e) {
        Color background = Primary ? (Enabled ? Color.Black : Color.FromArgb(52,52,52)) : Color.White;
        Color foreground = Primary ? (Enabled ? Color.White : Color.WhiteSmoke) : (Enabled ? Color.Black : Color.DimGray);
        e.Graphics.Clear(background);
        if (!Primary) using (var pen = new Pen(Color.Gainsboro)) e.Graphics.DrawRectangle(pen,0,0,Width-1,Height-1);
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, foreground, background, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        if (Focused && ShowFocusCues && Enabled) ControlPaint.DrawFocusRectangle(e.Graphics,Rectangle.Inflate(ClientRectangle,-4,-4),foreground,background);
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
