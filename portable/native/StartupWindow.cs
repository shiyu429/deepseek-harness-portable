using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
sealed class StartupWindow : IDisposable {
 readonly ManualResetEvent ready=new ManualResetEvent(false); CrispForm form; Label status; volatile bool disposed;
 public StartupWindow(){var thread=new Thread(()=>{try{
 Application.EnableVisualStyles();
 form=new CrispForm{Text="DSH Portable",ClientSize=new Size(480,290),StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedSingle,ControlBox=false,BackColor=Color.White,ForeColor=Color.Black,AutoScaleDimensions=new SizeF(96,96),AutoScaleMode=AutoScaleMode.None,Font=new Font("Microsoft YaHei UI",10)};
 form.Icon=UiKit.BrandIcon();
 form.Controls.Add(new PictureBox{Left=36,Top=38,Width=48,Height=48,SizeMode=PictureBoxSizeMode.Zoom,Image=UiKit.BrandImage()});
 form.Controls.Add(new Label{Text="DSH Portable",Left=104,Top=32,Width=335,Height=40,Font=new Font("Segoe UI",22,FontStyle.Bold),BackColor=Color.White});
 form.Controls.Add(new Label{Text="DeepSeek Harness · 便携版",Left=107,Top=77,Width=332,Height=25,ForeColor=Color.DimGray});
 form.Controls.Add(new LoadingRing{Left=36,Top=153,Width=32,Height=32});
 status=new Label{Text="正在准备启动",Left=87,Top=157,Width=355,Height=29,AutoEllipsis=true,BackColor=Color.White};form.Controls.Add(status);
 form.Controls.Add(new Label{Text="你的工作，随盘继续。",Left=37,Top=232,Width=390,Height=24,ForeColor=Color.Gray,Font=new Font("Microsoft YaHei UI",9)});
 form.FitDpi();form.FormClosing+=(s,e)=>{if(!disposed)e.Cancel=true;};form.Shown+=(s,e)=>ready.Set();Application.Run(form);}catch(Exception error){disposed=true;ready.Set();Console.Error.WriteLine("启动界面："+error.Message);}
 });thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();ready.WaitOne(5000);}
 public void Update(string message,int completed=0,int total=0){if(disposed||form==null||!form.IsHandleCreated)return;try{form.BeginInvoke(new Action(()=>status.Text=message));}catch(InvalidOperationException){}}
 public void UntilVisible(Process child){Update("正在打开工作空间");ThreadPool.QueueUserWorkItem(state=>{try{while(!disposed&&!child.WaitForExit(150)){child.Refresh();if(child.MainWindowHandle!=IntPtr.Zero)break;}}catch(InvalidOperationException){}Dispose();});}
 public static int Smoke(string filename){using(var w=new StartupWindow()){w.Update("正在检查启动文件  4096 / 8192");w.form.Invoke(new Action(()=>{using(var b=new Bitmap(w.form.Width,w.form.Height)){w.form.DrawToBitmap(b,new Rectangle(Point.Empty,b.Size));b.Save(filename);}}));}return 0;}
 public void Dispose(){if(disposed)return;disposed=true;if(form!=null&&form.IsHandleCreated)try{form.BeginInvoke(new Action(()=>form.Close()));}catch(InvalidOperationException){}}
}
