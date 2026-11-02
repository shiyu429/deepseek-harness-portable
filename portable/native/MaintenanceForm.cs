using System;
using System.IO;
using System.Linq;
using System.Drawing;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows.Forms;
using File = WindowsFile;
using Directory = WindowsDirectory;
sealed class MaintenanceForm : CrispForm {
 readonly string root;
 readonly Panel content=new Panel{Dock=DockStyle.Fill,BackColor=Color.White,Padding=new Padding(26,22,26,16),AutoScroll=true};
 readonly Label status=new Label{Dock=DockStyle.Fill,Text="就绪",TextAlign=ContentAlignment.MiddleLeft,AutoEllipsis=true,BackColor=Color.White,ForeColor=Color.DimGray};
 readonly LoadingRing activity=new LoadingRing{Width=24,Height=24,Left=20,Top=14,Visible=false};
 readonly Dictionary<string,Button> navigation=new Dictionary<string,Button>();readonly List<Font> fonts=new List<Font>();
 bool busy;volatile bool checking;string selectedZip;string selectedPage="概览";
 string checkSummary="尚未开始检查",checkDetails="";int checkCompleted,checkTotal;
 public MaintenanceForm(string directory){root=Path.GetFullPath(directory);Text="DSH · 便携维护中心";AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.None;Font=new Font("Microsoft YaHei UI",10);ClientSize=new Size(860,580);MinimumSize=new Size(640,440);StartPosition=FormStartPosition.CenterScreen;BackColor=Color.White;ForeColor=Color.Black;Icon=UiKit.BrandIcon();DoubleBuffered=true;
 var header=new Panel{Dock=DockStyle.Top,Height=96,BackColor=Color.White};header.Controls.Add(new PictureBox{Left=24,Top=22,Width=44,Height=44,SizeMode=PictureBoxSizeMode.Zoom,Image=UiKit.BrandImage()});header.Controls.Add(TextAt("DSH",90,15,200,36,22,true));header.Controls.Add(TextAt("便携维护中心",92,55,250,24,10,false,true));header.Controls.Add(new Panel{Dock=DockStyle.Bottom,Height=1,BackColor=Color.Gainsboro});
 var sidebar=new Panel{Dock=DockStyle.Left,Width=168,BackColor=Color.White};int y=20;
 foreach(var name in new[]{"概览","安装与更新","程序检查","数据与说明"}){string target=name;var button=new Button{Text=name,Left=12,Top=y,Width=144,Height=40,FlatStyle=FlatStyle.Flat,TextAlign=ContentAlignment.MiddleLeft,Padding=new Padding(12,0,0,0),BackColor=Color.White,Cursor=ActionCursor};button.FlatAppearance.BorderSize=0;button.FlatAppearance.MouseOverBackColor=Color.WhiteSmoke;button.Click+=(s,e)=>ShowPage(target);navigation[name]=button;sidebar.Controls.Add(button);y+=48;}sidebar.Controls.Add(new Panel{Dock=DockStyle.Right,Width=1,BackColor=Color.Gainsboro});
 var footer=new Panel{Dock=DockStyle.Bottom,Height=44,BackColor=Color.White,Padding=new Padding(58,0,28,0)};footer.Controls.Add(status);footer.Controls.Add(activity);Controls.Add(content);Controls.Add(sidebar);Controls.Add(footer);Controls.Add(header);content.SizeChanged+=(s,e)=>FitPageWidth();FormClosing+=(s,e)=>{if(busy){e.Cancel=true;status.Text="正在处理，请等待完成后关闭。";}};ShowPage("概览");FitDpi();}
 float UiScale {get{return LayoutScale;}}
 protected override void OnDpiLayoutChanged(){FitPageWidth();}
 void FitPageWidth(){if(content==null)return;int min=(int)Math.Round(620*UiScale),width=Math.Max(min,content.ClientSize.Width-(int)Math.Round(52*UiScale));foreach(Control part in content.Controls){part.MinimumSize=new Size(min,0);if(part.Width!=width)part.Width=width;}}
 Label TextAt(string text,int x,int y,int width,int height,float size=10,bool bold=false,bool muted=false){var f=new Font("Microsoft YaHei UI",size,bold?FontStyle.Bold:FontStyle.Regular);fonts.Add(f);return new Label{Text=text,Left=x,Top=y,Width=width,Height=height,Font=f,ForeColor=muted?Color.DimGray:Color.Black,BackColor=Color.White,AutoEllipsis=true};}
 Panel Section(int top,int height){var p=new Panel{MinimumSize=new Size(620,0),Left=26,Top=top+22,Width=Math.Max(620,(int)(content.ClientSize.Width/UiScale)-52),Height=height,BackColor=Color.White,Anchor=AnchorStyles.Top|AnchorStyles.Left};content.Controls.Add(p);return p;}
 void Rule(Panel p,int y){p.Controls.Add(new Panel{Left=0,Top=y,Width=p.Width,Height=1,Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right,BackColor=Color.Gainsboro});}
 Button Action(Panel p,string text,int x,int y,int width,EventHandler handler,bool primary=false){var b=new ActionButton{Primary=primary,Text=text,Left=x,Top=y,Width=width,Height=42,FlatStyle=FlatStyle.Flat,BackColor=primary?Color.Black:Color.White,ForeColor=primary?Color.White:Color.Black,Cursor=ActionCursor};b.FlatAppearance.BorderColor=Color.Gainsboro;b.FlatAppearance.BorderSize=primary?0:1;b.Click+=handler;p.Controls.Add(b);return b;}
 string Version(){try{return Launcher.Text(Launcher.Read(MaintenanceEngine.Pointer(root)),"portableVersion");}catch{return "待检查";}}
 void ShowPage(string name){if(busy)return;selectedPage=name;content.SuspendLayout();foreach(Control c in content.Controls.Cast<Control>().ToArray())c.Dispose();content.Controls.Clear();foreach(var item in navigation){item.Value.BackColor=item.Key==name?Color.WhiteSmoke:Color.White;item.Value.ForeColor=Color.Black;}var title=Section(0,76);title.Controls.Add(TextAt(name=="概览"?"便携版概览":name,0,0,620,43,24,true));title.Controls.Add(TextAt(name=="安装与更新"?"选择最新完整版 ZIP，数据保持原位。":name=="数据与说明"?"找到你的文件，继续下一项工作。":"管理当前程序和随盘保存的数据。",0,55,620,28,10,false,true));if(name=="概览")Home();else if(name=="安装与更新")UpdatePage();else if(name=="程序检查")VerifyPage();else DataPage();if(UiScale!=1)foreach(Control part in content.Controls)part.Scale(new SizeF(UiScale,UiScale));content.ResumeLayout();FitPageWidth();}
 void Home(){var p=Section(96,224);p.Controls.Add(TextAt("当前版本",0,0,600,25,10,false,true));p.Controls.Add(TextAt(Version(),0,39,600,55,33,true));p.Controls.Add(TextAt("DeepSeek Harness Portable",0,106,600,28,12));Action(p,"启动 DSH",0,145,166,(s,e)=>{try{Process.Start(new ProcessStartInfo{FileName=Path.Combine(root,"DSH Portable.exe"),WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true});}catch(Exception error){status.Text=error.Message;}},true);Rule(p,208);var q=Section(336,80);q.Controls.Add(TextAt("日常使用无需打开维护中心。",0,0,600,29,12,true));q.Controls.Add(TextAt("更新程序、核对文件或打开数据目录时，再从这里开始。",0,32,620,45,10,false,true));}
 void SetContentActions(bool enabled){Action<Control> visit=null;visit=control=>{foreach(Control child in control.Controls){if(child is ButtonBase||child is TextBoxBase||child is ComboBox)child.Enabled=enabled;visit(child);}};visit(content);}
 async Task Operation(Func<Task> action){if(busy)return;busy=true;SetContentActions(false);activity.Visible=true;foreach(var b in navigation.Values)b.Enabled=false;try{await action();}catch(Exception error){status.Text=error.Message;MessageBox.Show(this,error.Message,"操作未完成",MessageBoxButtons.OK,MessageBoxIcon.Information);}finally{busy=false;SetContentActions(true);activity.Visible=false;foreach(var b in navigation.Values)b.Enabled=true;ShowPage(selectedPage);}}
 void Progress(string text){if(!IsDisposed&&IsHandleCreated)BeginInvoke(new Action(()=>status.Text=text));}
 void UpdatePage(){var p=Section(96,246);p.Controls.Add(TextAt("安装最新完整版",0,0,620,31,14,true));p.Controls.Add(TextAt("请先从托盘完整退出 DSH。安装期间可以在此查看状态。",0,49,620,45,10,false,true));var path=new TextBox{Left=0,Top=103,Width=590,Height=32,ReadOnly=true,Text=selectedZip??"尚未选择 ZIP 文件",BorderStyle=BorderStyle.FixedSingle,BackColor=Color.White,Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right};p.Controls.Add(path);Action(p,"选择文件",0,142,132,(s,e)=>{using(var d=new OpenFileDialog{Filter="便携程序包 (*.zip)|*.zip",Title="选择最新完整版或兼容程序包"})if(d.ShowDialog(this)==DialogResult.OK){selectedZip=d.FileName;path.Text=selectedZip;}});Action(p,"检查并安装",150,142,166,async(s,e)=>{if(selectedZip==null){status.Text="请先选择 ZIP 文件。";return;}await Operation(async()=>{await Task.Run(()=>{var transaction=MaintenanceEngine.Prepare(root,selectedZip,true,Progress,true);if(MaintenanceEngine.Finish(transaction,null,true)!=0)throw new IOException(MaintenanceEngine.ResultMessage(root));});Installed();});},true);Rule(p,229);if(File.Exists(Path.Combine(root,"app/.update.pending.json"))){var q=Section(354,100);q.Controls.Add(TextAt("检测到尚未完成的安装",0,0,600,30,12,true));Action(q,"继续安装",0,51,166,async(s,e)=>await Operation(async()=>{status.Text="正在继续安装…";await Task.Run(()=>MaintenanceEngine.ResumeInPlace(root));Installed();}),true);}}
 void Installed(){string result=MaintenanceEngine.ResultMessage(root);status.Text=result.Split(new[]{"\r\n"},StringSplitOptions.None)[0];if(result.Contains("\r\n"))MessageBox.Show(this,result,"安装完成 · 清理待办",MessageBoxButtons.OK,MessageBoxIcon.Information);}
 void VerifyPage(){
  var p=Section(96,306);
  p.Controls.Add(TextAt("检查程序文件",0,0,620,32,14,true));
  p.Controls.Add(TextAt("核对当前程序和运行环境，检查缺失或损坏的文件。",0,48,620,45,11,false,true));
  var summary=TextAt(checkSummary,185,119,430,38,10,true);p.Controls.Add(summary);
  var bar=new ProgressBar{Left=0,Top=176,Width=590,Height=8,Minimum=0,Maximum=Math.Max(1,checkTotal),Value=Math.Min(checkCompleted,Math.Max(1,checkTotal)),Style=ProgressBarStyle.Continuous,Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right};p.Controls.Add(bar);
  var details=TextAt(checkDetails,0,199,620,60,9,false,true);details.Name="verification-file";p.Controls.Add(details);
  Button start=null;
  start=Action(p,"开始检查",0,115,166,async(s,e)=>await Operation(async()=>{
   checking=true;checkCompleted=0;checkTotal=0;checkSummary="正在读取检查清单…";checkDetails="请稍候，程序和用户数据保持原位。";
   status.Text="正在核对文件…";start.Text="正在检查…";summary.Text=checkSummary;details.Text=checkDetails;bar.Value=0;
   try{
    await Task.Run(()=>{using(var locked=MaintenanceEngine.ReadLock(root))Launcher.Verify(root,null,(file,done,total)=>{
     if(IsDisposed||!IsHandleCreated)return;
     BeginInvoke(new Action(()=>{if(!checking)return;checkCompleted=done;checkTotal=total;checkSummary=done+" / "+total+"（"+(done*100L/total)+"%）";checkDetails=file;summary.Text=checkSummary;bar.Maximum=Math.Max(1,total);bar.Value=done;details.Text=file;status.Text="正在检查文件  "+checkSummary;}));
    });});
    checkCompleted=checkTotal;checkSummary="检查通过";checkDetails="程序文件完整，数据格式兼容。";status.Text="检查通过：程序文件完整，数据格式兼容。";
   }catch(Exception error){checkSummary="检查未通过";checkDetails=error.Message;throw;}
   finally{checking=false;start.Text="开始检查";summary.Text=checkSummary;details.Text=checkDetails;}
  }),true);
  Action(p,"清理旧程序与安装缓存",0,246,265,async(s,e)=>await Operation(async()=>{status.Text="正在清理本程序的旧版本和暂存文件…";var remaining=await Task.Run(()=>MaintenanceEngine.Cleanup(root));status.Text=remaining.Length==0?"清理完成，用户数据未修改。":"部分文件仍被占用，请关闭相关程序后重试。";if(remaining.Length!=0)MessageBox.Show(this,String.Join("\r\n",remaining),"尚未清理的文件",MessageBoxButtons.OK,MessageBoxIcon.Information);}));
 }
 void DataPage(){var p=Section(96,197);p.Controls.Add(TextAt("你的数据",0,0,620,32,14,true));p.Controls.Add(TextAt("聊天、设置、插件和默认工作文件保存在 data。",0,48,620,30,11,false,true));p.Controls.Add(TextAt("复制到其他电脑时，请先退出，再复制整个便携文件夹。",0,88,620,36,10,false,true));Action(p,"打开数据目录",0,140,174,(s,e)=>Open(Path.Combine(root,"data")),true);Action(p,"许可证与来源",192,140,174,(s,e)=>Open(Path.Combine(root,"app/说明与许可")));var q=Section(316,96);Rule(q,0);q.Controls.Add(TextAt("便携目录",0,28,620,24,9,false,true));q.Controls.Add(TextAt(root,0,60,620,36,10));}
 void Open(string path){try{if(!Directory.Exists(path)&&!File.Exists(path))throw new IOException("此位置尚未创建。");Process.Start(new ProcessStartInfo{FileName=path,UseShellExecute=true});}catch(Exception error){status.Text=error.Message;}}
 public static int Smoke(string root,string output,bool runCheck=false){
  using(var f=new MaintenanceForm(root)){
   f.Show();Application.DoEvents();
   if(runCheck){
    f.ShowPage("程序检查");Application.DoEvents();System.Threading.SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
    var start=f.content.Controls.Cast<Control>().SelectMany(p=>p.Controls.Cast<Control>()).OfType<ActionButton>().Single(b=>b.Text=="开始检查");
    bool captured=false;
    var details=f.content.Controls.Cast<Control>().SelectMany(p=>p.Controls.Cast<Control>()).Single(c=>c.Name=="verification-file");
    details.TextChanged+=(s,e)=>{if(!captured&&f.checking&&f.checkTotal>0){using(var b=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(b,new Rectangle(Point.Empty,b.Size));b.Save(output+".检查中.png");}captured=true;}};
    start.PerformClick();var deadline=DateTime.UtcNow.AddSeconds(120);
    while(f.busy){
     Application.DoEvents();
     if(!captured&&f.checkTotal>0){using(var b=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(b,new Rectangle(Point.Empty,b.Size));b.Save(output+".检查中.png");}captured=true;}
     if(DateTime.UtcNow>deadline)throw new IOException("UI verification timed out");
     System.Threading.Thread.Sleep(2);
    }
    Application.DoEvents();
    if(!captured||f.checkSummary!="检查通过")throw new IOException("UI verification did not complete: captured="+captured+", summary="+f.checkSummary+", detail="+f.checkDetails);
    using(var b=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(b,new Rectangle(Point.Empty,b.Size));b.Save(output+".检查完成.png");}
   }else{
    foreach(var page in new[]{"概览","安装与更新","程序检查","数据与说明"}){f.ShowPage(page);Application.DoEvents();using(var b=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(b,new Rectangle(Point.Empty,b.Size));b.Save(output+"."+page+".png");}}
   }
   f.Close();
  }return 0;
 }
 protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing)foreach(var f in fonts)f.Dispose();}
}
